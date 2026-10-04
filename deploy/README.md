# Deploying Neighbourhood Flex on AWS

One EC2 instance in `ap-south-1` (Mumbai) runs three containers with Docker Compose:

```text
Browser ──HTTPS──► Caddy (Let's Encrypt)
                     ├─ /api/twin-model, everything else ─► frontend (Next.js, port 3000)
                     └─ /api/*, /ws/*                     ─► backend  (FastAPI engine, port 8000)
```

- **HTTPS:** a free `<elastic-ip>.sslip.io` hostname with a Let's Encrypt certificate that Caddy renews automatically.
- **Public:** no login. Anyone with the URL can view and control the simulation (Run, Step, Reset, Approve).
- **One backend:** exactly one backend container, because the simulation is a single in-memory engine shared by all viewers. Restarting it restarts the simulation.
- **No SSH:** port 22 is closed. The instance is managed through AWS Systems Manager (SSM), and releases go through a private S3 bucket.

## Resources

All tagged `Project=neighbourhood-flex`. IDs are in `deploy/aws.env`, which is git-ignored.

| Resource | Name / purpose |
|---|---|
| EC2 instance | `neighbourhood-flex`, t3.small, Amazon Linux 2023, 20 GB encrypted gp3, IMDSv2 only |
| Elastic IP | stable address behind the sslip.io hostname |
| Security group | `neighbourhood-flex-web`: inbound 80 and 443 only |
| IAM role + instance profile | `neighbourhood-flex-ec2`: SSM managed instance + read from the release bucket |
| S3 bucket | `neighbourhood-flex-releases-<account>`: private, holds `release.tar.gz` |

Approximate cost: about $22/month (t3.small ~$16, public IPv4 ~$3.65, disk ~$2).

## Redeploy after code changes

From the repo root, in Git Bash (Windows) or a Linux/macOS shell:

```bash
bash deploy/release.sh
```

It packages `backend/`, `frontend/` and this folder, renders the `Caddyfile`, uploads to S3, and runs `server-deploy.sh` on the instance through SSM, which rebuilds the images and restarts the stack. A build takes about 5 minutes on a t3.small.

## Logs

```bash
aws ssm start-session --region ap-south-1 --target <INSTANCE_ID>   # needs the Session Manager plugin
sudo docker compose -f /opt/neighbourhood-flex/deploy/docker-compose.yml logs -f --tail 100
```

## Tear down

Values come from `deploy/aws.env`:

```bash
aws ec2 terminate-instances --region ap-south-1 --instance-ids <INSTANCE_ID>
aws ec2 wait instance-terminated --region ap-south-1 --instance-ids <INSTANCE_ID>
aws ec2 release-address --region ap-south-1 --allocation-id <ELASTIC_IP_ALLOCATION>
aws ec2 delete-security-group --region ap-south-1 --group-id <SECURITY_GROUP>
aws iam remove-role-from-instance-profile --instance-profile-name neighbourhood-flex-ec2 --role-name neighbourhood-flex-ec2
aws iam delete-instance-profile --instance-profile-name neighbourhood-flex-ec2
aws iam delete-role-policy --role-name neighbourhood-flex-ec2 --policy-name read-releases
aws iam detach-role-policy --role-name neighbourhood-flex-ec2 --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role --role-name neighbourhood-flex-ec2
aws s3 rb s3://<BUCKET> --force
```

To pause costs without deleting anything, stop the instance (`aws ec2 stop-instances ...`). The Elastic IP keeps the same URL, but it is still billed (~$3.65/month) while the instance is stopped.
