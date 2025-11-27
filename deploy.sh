#!/bin/bash

echo "======================================"
echo "File Sharing App - VM Deployment"
echo "======================================"
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null
then
    echo "Docker is not installed. Installing Docker..."
    sudo apt update
    sudo apt install -y docker.io docker-compose
    sudo systemctl start docker
    sudo systemctl enable docker
    sudo usermod -aG docker $USER
    echo "Docker installed successfully!"
    echo "Please log out and log back in for group changes to take effect."
    exit 1
fi

echo "Docker is installed ✓"
echo ""

# Stop and remove existing container if it exists
if [ "$(docker ps -aq -f name=file-sharing)" ]; then
    echo "Stopping existing container..."
    docker stop file-sharing 2>/dev/null
    docker rm file-sharing 2>/dev/null
    echo "Existing container removed ✓"
fi

# Build the Docker image
echo ""
echo "Building Docker image..."
docker build -t file-sharing-app .

if [ $? -eq 0 ]; then
    echo "Docker image built successfully ✓"
else
    echo "Failed to build Docker image ✗"
    exit 1
fi

# Run the container
echo ""
echo "Starting container..."
docker run -d \
  --name file-sharing \
  -p 5000:5000 \
  -v $(pwd)/uploads:/app/uploads \
  --restart unless-stopped \
  file-sharing-app

if [ $? -eq 0 ]; then
    echo "Container started successfully ✓"
else
    echo "Failed to start container ✗"
    exit 1
fi

# Wait a moment for the container to start
sleep 3

# Check if container is running
if [ "$(docker ps -q -f name=file-sharing)" ]; then
    echo ""
    echo "======================================"
    echo "Deployment Successful! 🚀"
    echo "======================================"
    echo ""
    echo "Application is running on:"
    echo "  - http://localhost:5000"
    echo "  - http://$(hostname -I | awk '{print $1}'):5000"
    echo ""
    echo "Useful commands:"
    echo "  - View logs:    docker logs -f file-sharing"
    echo "  - Stop app:     docker stop file-sharing"
    echo "  - Start app:    docker start file-sharing"
    echo "  - Restart app:  docker restart file-sharing"
    echo ""
else
    echo "Container failed to start. Check logs with: docker logs file-sharing"
    exit 1
fi
