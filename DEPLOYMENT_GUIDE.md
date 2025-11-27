# Ubuntu Deployment Guide - File Sharing Application

This guide provides step-by-step instructions to deploy your Flask file sharing application on Ubuntu.

## Table of Contents
1. [Method 1: Docker Deployment (Recommended)](#method-1-docker-deployment-recommended)
2. [Method 2: Traditional Deployment with systemd](#method-2-traditional-deployment-with-systemd)
3. [Method 3: Production Deployment with Nginx + Gunicorn](#method-3-production-deployment-with-nginx--gunicorn)
4. [SSL/HTTPS Setup (Optional)](#sslhttps-setup-optional)
5. [Firewall Configuration](#firewall-configuration)

---

## Prerequisites

- Ubuntu Server (20.04 LTS or later recommended)
- Root or sudo access
- Basic knowledge of Linux command line

---

## Method 1: Docker Deployment (Recommended)

This is the easiest and most portable deployment method.

### Step 1: Update System
```bash
sudo apt update
sudo apt upgrade -y
```

### Step 2: Install Docker
```bash
# Install dependencies
sudo apt install -y apt-transport-https ca-certificates curl software-properties-common

# Add Docker's official GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

# Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io

# Add your user to docker group (optional, to run without sudo)
sudo usermod -aG docker $USER
newgrp docker
```

### Step 3: Transfer Files to Server
```bash
# On your local machine, transfer files to the server
scp -r /path/to/file-sharing-app user@your-server-ip:/home/user/file-sharing
```

Or clone from git:
```bash
# On the server
cd ~
git clone <your-repository-url> file-sharing
cd file-sharing
```

### Step 4: Build and Run Docker Container
```bash
cd ~/file-sharing

# Build the Docker image
docker build -t file-sharing-app .

# Run the container
docker run -d \
  --name file-sharing \
  -p 5000:5000 \
  -v $(pwd)/uploads:/app/uploads \
  --restart unless-stopped \
  file-sharing-app
```

### Step 5: Verify Deployment
```bash
# Check if container is running
docker ps

# View logs
docker logs file-sharing

# Test the application
curl http://localhost:5000
```

### Step 6: Access Your Application
Open your browser and navigate to:
- `http://your-server-ip:5000`

### Docker Management Commands
```bash
# Stop the container
docker stop file-sharing

# Start the container
docker start file-sharing

# Restart the container
docker restart file-sharing

# View logs
docker logs -f file-sharing

# Remove container
docker rm -f file-sharing

# Rebuild after changes
docker build -t file-sharing-app .
docker rm -f file-sharing
docker run -d --name file-sharing -p 5000:5000 -v $(pwd)/uploads:/app/uploads --restart unless-stopped file-sharing-app
```

---

## Method 2: Traditional Deployment with systemd

This method runs the application directly on the server without Docker.

### Step 1: Update System and Install Python
```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y python3 python3-pip python3-venv
```

### Step 2: Create Application Directory
```bash
sudo mkdir -p /var/www/file-sharing
sudo chown $USER:$USER /var/www/file-sharing
```

### Step 3: Transfer Application Files
```bash
# From your local machine
scp -r /path/to/file-sharing-app/* user@your-server-ip:/var/www/file-sharing/

# Or use git on the server
cd /var/www/file-sharing
git clone <your-repository-url> .
```

### Step 4: Set Up Python Virtual Environment
```bash
cd /var/www/file-sharing

# Create virtual environment
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### Step 5: Test the Application
```bash
# Still in virtual environment
python ip.py
```

Visit `http://your-server-ip:5000` to verify it works. Press `Ctrl+C` to stop.

### Step 6: Create systemd Service
```bash
# Copy the service file
sudo cp file-sharing.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable file-sharing

# Start the service
sudo systemctl start file-sharing

# Check status
sudo systemctl status file-sharing
```

### Step 7: Verify Deployment
```bash
# Check service status
sudo systemctl status file-sharing

# View logs
sudo journalctl -u file-sharing -f
```

### systemd Management Commands
```bash
# Start service
sudo systemctl start file-sharing

# Stop service
sudo systemctl stop file-sharing

# Restart service
sudo systemctl restart file-sharing

# View logs
sudo journalctl -u file-sharing -f

# Disable service
sudo systemctl disable file-sharing
```

---

## Method 3: Production Deployment with Nginx + Gunicorn

This is the recommended method for production environments with high traffic.

### Step 1: Install Nginx and Gunicorn
```bash
sudo apt update
sudo apt install -y nginx
```

### Step 2: Follow Method 2 Steps 1-4
Complete steps 1-4 from Method 2 to set up the application.

### Step 3: Install Gunicorn
```bash
cd /var/www/file-sharing
source venv/bin/activate
pip install gunicorn
```

### Step 4: Test Gunicorn
```bash
gunicorn --bind 0.0.0.0:5000 ip:app
```

Press `Ctrl+C` to stop after verifying it works.

### Step 5: Create Gunicorn systemd Service
Create `/etc/systemd/system/file-sharing-gunicorn.service`:
```bash
sudo nano /etc/systemd/system/file-sharing-gunicorn.service
```

Add this content:
```ini
[Unit]
Description=Gunicorn instance for File Sharing Application
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/var/www/file-sharing
Environment="PATH=/var/www/file-sharing/venv/bin"
ExecStart=/var/www/file-sharing/venv/bin/gunicorn --workers 4 --bind 127.0.0.1:5000 ip:app
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Step 6: Set Proper Permissions
```bash
sudo chown -R www-data:www-data /var/www/file-sharing
sudo chmod -R 755 /var/www/file-sharing
```

### Step 7: Start Gunicorn Service
```bash
sudo systemctl daemon-reload
sudo systemctl enable file-sharing-gunicorn
sudo systemctl start file-sharing-gunicorn
sudo systemctl status file-sharing-gunicorn
```

### Step 8: Configure Nginx
```bash
# Copy nginx configuration
sudo cp nginx.conf /etc/nginx/sites-available/file-sharing

# Edit the configuration to set your domain
sudo nano /etc/nginx/sites-available/file-sharing
# Change 'your-domain.com' to your actual domain or server IP

# Create symbolic link
sudo ln -s /etc/nginx/sites-available/file-sharing /etc/nginx/sites-enabled/

# Remove default site (optional)
sudo rm /etc/nginx/sites-enabled/default

# Test nginx configuration
sudo nginx -t

# Restart nginx
sudo systemctl restart nginx
```

### Step 9: Verify Deployment
Visit `http://your-domain.com` or `http://your-server-ip` in your browser.

---

## SSL/HTTPS Setup (Optional)

### Using Let's Encrypt (Free SSL Certificate)

### Step 1: Install Certbot
```bash
sudo apt install -y certbot python3-certbot-nginx
```

### Step 2: Obtain SSL Certificate
```bash
# Make sure your domain points to your server IP first
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

### Step 3: Test Auto-Renewal
```bash
sudo certbot renew --dry-run
```

The certificate will auto-renew every 90 days.

### Step 4: Verify HTTPS
Visit `https://your-domain.com` in your browser.

---

## Firewall Configuration

### Using UFW (Uncomplicated Firewall)

```bash
# Enable UFW
sudo ufw enable

# Allow SSH (important!)
sudo ufw allow ssh
sudo ufw allow 22/tcp

# Allow HTTP
sudo ufw allow 80/tcp

# Allow HTTPS (if using SSL)
sudo ufw allow 443/tcp

# If using Docker directly without Nginx
sudo ufw allow 5000/tcp

# Check status
sudo ufw status verbose
```

---

## Monitoring and Maintenance

### View Application Logs

**Docker:**
```bash
docker logs -f file-sharing
```

**systemd:**
```bash
sudo journalctl -u file-sharing -f
# or for gunicorn
sudo journalctl -u file-sharing-gunicorn -f
```

**Nginx:**
```bash
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Check Disk Space (Important for file uploads)
```bash
df -h
du -sh /var/www/file-sharing/uploads
```

### Monitor System Resources
```bash
# Install htop
sudo apt install htop

# Run htop
htop
```

### Backup Uploaded Files
```bash
# Create backup
sudo tar -czf file-sharing-backup-$(date +%Y%m%d).tar.gz /var/www/file-sharing/uploads

# Or with Docker
docker run --rm -v file-sharing_uploads:/uploads -v $(pwd):/backup ubuntu tar czf /backup/uploads-backup-$(date +%Y%m%d).tar.gz /uploads
```

---

## Troubleshooting

### Application Won't Start
```bash
# Check logs
sudo journalctl -u file-sharing -n 50

# Check if port is already in use
sudo netstat -tulpn | grep 5000

# Check file permissions
ls -la /var/www/file-sharing
```

### Cannot Access from Browser
```bash
# Check if service is running
sudo systemctl status file-sharing

# Check firewall
sudo ufw status

# Check if nginx is running
sudo systemctl status nginx

# Test locally
curl http://localhost:5000
```

### Permission Errors
```bash
# Fix ownership
sudo chown -R www-data:www-data /var/www/file-sharing

# Fix permissions
sudo chmod -R 755 /var/www/file-sharing
sudo chmod -R 775 /var/www/file-sharing/uploads
```

### High Memory Usage
```bash
# Reduce Gunicorn workers in the service file
# Edit /etc/systemd/system/file-sharing-gunicorn.service
# Change --workers 4 to --workers 2

sudo systemctl daemon-reload
sudo systemctl restart file-sharing-gunicorn
```

---

## Performance Optimization Tips

1. **Increase Upload Size Limits:**
   - Edit nginx.conf and increase `client_max_body_size`
   - Restart nginx: `sudo systemctl restart nginx`

2. **Use a CDN** for static files (logo, CSS, JS)

3. **Enable Nginx Caching** for better performance

4. **Monitor with Tools:**
   - Install: `sudo apt install prometheus-node-exporter`
   - Use monitoring tools like Grafana, Prometheus, or New Relic

5. **Database for Metadata** (future enhancement):
   - Consider using PostgreSQL or MySQL for file metadata instead of filesystem

---

## Security Best Practices

1. **Keep System Updated:**
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

2. **Use Strong Firewall Rules:**
   - Only open necessary ports
   - Use UFW or iptables

3. **Regular Backups:**
   - Automate backups with cron jobs
   - Store backups off-site

4. **Disable Root Login:**
   ```bash
   sudo nano /etc/ssh/sshd_config
   # Set: PermitRootLogin no
   sudo systemctl restart sshd
   ```

5. **Use Fail2Ban:**
   ```bash
   sudo apt install fail2ban
   sudo systemctl enable fail2ban
   sudo systemctl start fail2ban
   ```

6. **Implement Rate Limiting** in Nginx to prevent abuse

7. **Regular Security Audits:**
   ```bash
   sudo apt install lynis
   sudo lynis audit system
   ```

---

## Uninstallation

### Docker Method
```bash
docker stop file-sharing
docker rm file-sharing
docker rmi file-sharing-app
```

### systemd Method
```bash
sudo systemctl stop file-sharing
sudo systemctl disable file-sharing
sudo rm /etc/systemd/system/file-sharing.service
sudo systemctl daemon-reload
sudo rm -rf /var/www/file-sharing
```

### Nginx + Gunicorn Method
```bash
sudo systemctl stop file-sharing-gunicorn nginx
sudo systemctl disable file-sharing-gunicorn
sudo rm /etc/systemd/system/file-sharing-gunicorn.service
sudo rm /etc/nginx/sites-enabled/file-sharing
sudo rm /etc/nginx/sites-available/file-sharing
sudo systemctl daemon-reload
sudo systemctl start nginx
sudo rm -rf /var/www/file-sharing
```

---

## Support and Further Assistance

- Check application logs for errors
- Review Ubuntu system logs: `sudo journalctl -xe`
- Ensure all dependencies are installed
- Verify network connectivity and DNS settings

---

## Quick Reference - Most Common Commands

```bash
# Docker
docker ps                                    # List running containers
docker logs -f file-sharing                 # View logs
docker restart file-sharing                 # Restart container

# systemd
sudo systemctl status file-sharing          # Check status
sudo systemctl restart file-sharing         # Restart service
sudo journalctl -u file-sharing -f          # View logs

# Nginx
sudo systemctl status nginx                 # Check nginx status
sudo nginx -t                               # Test configuration
sudo systemctl restart nginx                # Restart nginx

# Firewall
sudo ufw status                             # Check firewall
sudo ufw allow 80/tcp                       # Open port

# System
df -h                                        # Check disk space
htop                                         # Monitor resources
```

---

**Deployment Complete!** Your File Sharing Application should now be running on Ubuntu.
