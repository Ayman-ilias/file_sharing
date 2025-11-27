# Quick Start Guide

## Step 1: Push to GitHub

On your local machine (Windows):

```bash
cd "d:\File Sharing"

# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - File Sharing Application"

# Add remote repository
git remote add origin https://github.com/Ayman-ilias/file_sharing.git

# Push to GitHub
git branch -M main
git push -u origin main
```

## Step 2: Deploy on Ubuntu VM

### Option A: Automated Deployment (Recommended)

SSH into your Ubuntu VM and run:

```bash
# Clone the repository
git clone https://github.com/Ayman-ilias/file_sharing.git
cd file_sharing

# Make deploy script executable
chmod +x deploy.sh

# Run deployment script
./deploy.sh
```

The script will automatically:
- Install Docker (if not installed)
- Build the Docker image
- Run the container
- Display access URLs

### Option B: Manual Deployment with Docker Compose

```bash
# Clone the repository
git clone https://github.com/Ayman-ilias/file_sharing.git
cd file_sharing

# Install Docker (if not installed)
sudo apt update
sudo apt install -y docker.io docker-compose

# Deploy
docker-compose up -d

# View logs
docker-compose logs -f
```

### Option C: Manual Docker Deployment

```bash
# Clone the repository
git clone https://github.com/Ayman-ilias/file_sharing.git
cd file_sharing

# Install Docker (if not installed)
sudo apt update
sudo apt install -y docker.io

# Build image
docker build -t file-sharing-app .

# Run container
docker run -d \
  --name file-sharing \
  -p 5000:5000 \
  -v $(pwd)/uploads:/app/uploads \
  --restart unless-stopped \
  file-sharing-app

# Check status
docker ps
docker logs file-sharing
```

## Step 3: Access Your Application

Open browser and go to:
```
http://YOUR_VM_IP:5000
```

Replace `YOUR_VM_IP` with your VM's IP address.

## Step 4: Open Firewall (if needed)

If you can't access the app from outside the VM:

```bash
# Using UFW
sudo ufw allow 5000/tcp
sudo ufw reload

# Or using iptables
sudo iptables -A INPUT -p tcp --dport 5000 -j ACCEPT
```

## Common Commands

### View Application Logs
```bash
docker logs -f file-sharing
```

### Stop Application
```bash
docker stop file-sharing
```

### Start Application
```bash
docker start file-sharing
```

### Restart Application
```bash
docker restart file-sharing
```

### Update Application
```bash
cd file_sharing
git pull
docker stop file-sharing
docker rm file-sharing
docker build -t file-sharing-app .
docker run -d --name file-sharing -p 5000:5000 -v $(pwd)/uploads:/app/uploads --restart unless-stopped file-sharing-app
```

### Remove Application
```bash
docker stop file-sharing
docker rm file-sharing
docker rmi file-sharing-app
cd ..
rm -rf file_sharing
```

## Troubleshooting

### Port already in use
```bash
# Find what's using port 5000
sudo netstat -tulpn | grep 5000

# Kill the process or use a different port
docker run -d --name file-sharing -p 8080:5000 ...
```

### Permission denied
```bash
# Add your user to docker group
sudo usermod -aG docker $USER
newgrp docker
```

### Container keeps restarting
```bash
# Check logs
docker logs file-sharing

# Run interactively to debug
docker run -it --rm file-sharing-app /bin/bash
```

## Getting VM IP Address

```bash
# Method 1
hostname -I

# Method 2
ip addr show

# Method 3
ifconfig
```

---

That's it! Your File Sharing App should now be running on your VM.
