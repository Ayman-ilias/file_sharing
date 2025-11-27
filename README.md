# File Sharing Application

A modern, user-friendly file sharing platform built with Flask. Upload and share files, folders, and text content with automatic cleanup after 30 days.

## Features

- 📄 **File Upload** - Upload single or multiple files
- 📁 **Folder Upload** - Upload entire folders with preserved structure
- 📝 **Text Sharing** - Share text content directly
- 🗂️ **Organized by Date** - Files organized by Today, Yesterday, and specific dates
- 🔄 **Auto-Delete** - Automatic cleanup of files older than 30 days
- 🎨 **Modern UI** - Beautiful gradient design with glassmorphism effects
- 📱 **Responsive** - Works on desktop, tablet, and mobile devices

## Quick Start with Docker

### Prerequisites
- Docker installed on your Ubuntu VM
- Git installed

### Deployment Steps

1. **Clone the repository**
```bash
git clone https://github.com/Ayman-ilias/file_sharing.git
cd file_sharing
```

2. **Build and run with Docker Compose**
```bash
docker-compose up -d
```

Or build and run manually:
```bash
# Build the image
docker build -t file-sharing-app .

# Run the container
docker run -d \
  --name file-sharing \
  -p 5000:5000 \
  -v $(pwd)/uploads:/app/uploads \
  --restart unless-stopped \
  file-sharing-app
```

3. **Access the application**
Open your browser and navigate to:
```
http://your-server-ip:5000
```

## Docker Commands

### View logs
```bash
docker logs -f file-sharing
```

### Stop the application
```bash
docker-compose down
# or
docker stop file-sharing
```

### Restart the application
```bash
docker-compose restart
# or
docker restart file-sharing
```

### Update the application
```bash
git pull
docker-compose down
docker-compose up -d --build
```

## Manual Deployment (Without Docker)

### Prerequisites
- Python 3.8 or higher
- pip

### Steps

1. **Clone the repository**
```bash
git clone https://github.com/Ayman-ilias/file_sharing.git
cd file_sharing
```

2. **Create virtual environment**
```bash
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. **Install dependencies**
```bash
pip install -r requirements.txt
```

4. **Run the application**
```bash
python ip.py
```

5. **Access the application**
```
http://localhost:5000
```

## Production Deployment

For production environments, it's recommended to use:
- Nginx as a reverse proxy
- Gunicorn as the WSGI server
- SSL/HTTPS with Let's Encrypt

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for detailed production deployment instructions.

## Configuration

### Change Port
Edit the last line in `ip.py`:
```python
app.run(host='0.0.0.0', port=5000, threaded=True)  # Change 5000 to your desired port
```

### Change Auto-Delete Period
Edit line 26 in `ip.py`:
```python
one_month_ago = datetime.now() - timedelta(days=30)  # Change 30 to your desired days
```

### Upload Size Limit
If using Nginx, edit the nginx configuration:
```nginx
client_max_body_size 100M;  # Adjust as needed
```

## File Structure

```
file_sharing/
├── ip.py                   # Main application file
├── logo.png                # Application logo (PNG)
├── logo.svg                # Application logo (SVG)
├── requirements.txt        # Python dependencies
├── Dockerfile              # Docker configuration
├── docker-compose.yml      # Docker Compose configuration
├── .dockerignore           # Docker ignore rules
├── .gitignore             # Git ignore rules
├── README.md              # This file
├── DEPLOYMENT_GUIDE.md    # Detailed deployment guide
└── uploads/               # Uploaded files directory
```

## Security Notes

- Files are automatically deleted after 30 days
- The application runs as a non-root user in Docker
- Keep your system and dependencies updated
- Use HTTPS in production environments
- Consider implementing authentication for sensitive use cases

## Firewall Configuration

If using UFW firewall on Ubuntu:
```bash
sudo ufw allow 5000/tcp
```

For production with Nginx:
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## Troubleshooting

### Container won't start
```bash
# Check logs
docker logs file-sharing

# Check if port is already in use
sudo netstat -tulpn | grep 5000
```

### Permission errors with uploads
```bash
# Fix permissions
chmod 755 uploads/
```

### Can't access from other machines
- Check firewall settings
- Ensure the application is listening on 0.0.0.0 (not 127.0.0.1)
- Verify port is open

## Technologies Used

- **Backend**: Flask (Python)
- **Frontend**: HTML, CSS, JavaScript
- **Deployment**: Docker
- **Web Server**: Flask development server (Gunicorn recommended for production)

## License

This project is open source and available for personal and commercial use.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions, please open an issue on GitHub.

---

**Made with ❤️ for easy file sharing**
