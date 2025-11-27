from flask import Flask, request, render_template_string, send_from_directory, redirect, url_for, send_file, jsonify
import os
import zipfile
from io import BytesIO
from datetime import datetime, timedelta
import hashlib
import json
import time
import threading

app = Flask(__name__)
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

def get_folder_hash():
    """Generate a hash of the current folder structure"""
    folders_by_date = get_files_by_date()
    content = json.dumps(folders_by_date, sort_keys=True)
    return hashlib.md5(content.encode()).hexdigest()

def delete_old_files():
    """Delete files older than 1 month"""
    one_month_ago = datetime.now() - timedelta(days=30)
    
    if not os.path.exists(UPLOAD_FOLDER):
        return
    
    for item in os.listdir(UPLOAD_FOLDER):
        item_path = os.path.join(UPLOAD_FOLDER, item)
        
        # Get creation/modification time
        if os.path.isfile(item_path):
            file_time = datetime.fromtimestamp(os.path.getctime(item_path))
            if file_time < one_month_ago:
                os.remove(item_path)
                print(f"Deleted old file: {item}")
        elif os.path.isdir(item_path):
            folder_time = datetime.fromtimestamp(os.path.getctime(item_path))
            if folder_time < one_month_ago:
                import shutil
                shutil.rmtree(item_path)
                print(f"Deleted old folder: {item}")

def auto_delete_scheduler():
    """Run delete_old_files every hour"""
    while True:
        delete_old_files()
        time.sleep(3600)  # Check every hour

# Start the auto-delete thread
delete_thread = threading.Thread(target=auto_delete_scheduler, daemon=True)
delete_thread.start()

def get_date_label(file_date):
    """Get date label for a file (Today, Yesterday, or specific date)"""
    today = datetime.now().date()
    file_date_only = file_date.date()
    
    if file_date_only == today:
        return "Today"
    elif file_date_only == today - timedelta(days=1):
        return "Yesterday"
    else:
        return file_date_only.strftime("%B %d, %Y")  # e.g., "November 08, 2025"

def get_files_by_date():
    """Organize files by date groups"""
    date_groups = {}
    
    if not os.path.exists(UPLOAD_FOLDER):
        return date_groups
    
    for item in os.listdir(UPLOAD_FOLDER):
        item_path = os.path.join(UPLOAD_FOLDER, item)
        
        # Get creation time
        creation_time = datetime.fromtimestamp(os.path.getctime(item_path))
        date_label = get_date_label(creation_time)
        
        if date_label not in date_groups:
            date_groups[date_label] = {'folders': {}, 'files': []}
        
        if os.path.isdir(item_path):
            # It's a folder
            folder_files = []
            for root, dirs, files in os.walk(item_path):
                for filename in files:
                    rel_path = os.path.relpath(os.path.join(root, filename), item_path)
                    folder_files.append(rel_path)
            date_groups[date_label]['folders'][item] = sorted(folder_files)
        else:
            # It's an individual file
            date_groups[date_label]['files'].append(item)
    
    # Sort files within each date group
    for date_label in date_groups:
        date_groups[date_label]['files'].sort()
    
    return date_groups

HTML = '''<!doctype html>
<html><head>
  <title>File Upload - Southern IoT</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 40px auto;
      max-width: 750px;
      background: #f4f7f8;
      color: #333;
    }
    header {
      text-align: center;
      margin-bottom: 40px;
    }
    header img {
      height: 120px;
      max-width: 90%;
    }
    .upload-section {
      background: #fff;
      padding: 25px;
      border-radius: 8px;
      box-shadow: 0 2px 5px #ccc;
      margin-bottom: 30px;
    }
    .upload-option {
      margin-bottom: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid #e0e0e0;
    }
    .upload-option:last-child {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .upload-option h3 {
      margin-top: 0;
      color: #4a90e2;
      font-size: 1.1em;
    }
    input[type=file] {
      margin-bottom: 10px;
      display: block;
      width: 100%;
    }
    input[type=submit], button.upload-btn {
      background: #4a90e2;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 1em;
      width: 100%;
    }
    input[type=submit]:hover, button.upload-btn:hover {
      background: #357ABD;
    }
    .date-section {
      margin-bottom: 30px;
    }
    .date-header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 15px 20px;
      border-radius: 8px;
      font-size: 1.3em;
      font-weight: bold;
      margin-bottom: 15px;
      box-shadow: 0 3px 10px rgba(102, 126, 234, 0.3);
    }
    ul {
      list-style: none;
      padding: 0;
    }
    li {
      background: #fff;
      margin-bottom: 10px;
      padding: 12px;
      border-radius: 6px;
      box-shadow: 0 1px 3px #ddd;
    }
    .item {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .folder-item {
      background: #f8f9fa;
      border-left: 4px solid #4a90e2;
    }
    .folder-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
    }
    .folder-name {
      font-weight: bold;
      color: #4a90e2;
      display: flex;
      align-items: center;
    }
    .folder-icon {
      margin-right: 8px;
      font-size: 1.2em;
    }
    .folder-files {
      margin-top: 10px;
      padding-left: 30px;
      display: none;
    }
    .folder-files.expanded {
      display: block;
    }
    .folder-file {
      padding: 5px 0;
      color: #666;
    }
    a {
      color: #4a90e2;
      text-decoration: none;
      word-break: break-all;
    }
    a:hover {
      text-decoration: underline;
    }
    .actions {
      display: flex;
      gap: 5px;
    }
    form.delete-form {
      margin: 0;
    }
    button.delete-button, button.download-button {
      border: none;
      color: white;
      padding: 5px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9em;
      white-space: nowrap;
    }
    button.delete-button {
      background: #e74c3c;
    }
    button.delete-button:hover {
      background: #c0392b;
    }
    button.download-button {
      background: #27ae60;
    }
    button.download-button:hover {
      background: #229954;
    }
    .file-info {
      flex-grow: 1;
    }
    .toggle-icon {
      transition: transform 0.3s;
      display: inline-block;
    }
    .toggle-icon.expanded {
      transform: rotate(90deg);
    }
    .status-indicator {
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 5px 10px;
      border-radius: 4px;
      font-size: 0.9em;
      background: #27ae60;
      color: white;
      opacity: 0;
      transition: opacity 0.3s;
    }
    .status-indicator.show {
      opacity: 1;
    }
    .no-files {
      text-align: center;
      padding: 40px;
      color: #999;
      font-style: italic;
    }
    .auto-delete-info {
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 6px;
      padding: 10px 15px;
      margin-bottom: 20px;
      font-size: 0.9em;
      color: #856404;
    }
  </style>
  <script>
    let expandedFolders = new Set();
    let currentHash = '{{ current_hash }}';
    let checkInterval;
    
    function toggleFolder(folderId) {
      const filesDiv = document.getElementById('files-' + folderId);
      const icon = document.getElementById('icon-' + folderId);
      filesDiv.classList.toggle('expanded');
      icon.classList.toggle('expanded');
      
      // Track expanded state
      if (filesDiv.classList.contains('expanded')) {
        expandedFolders.add(folderId);
      } else {
        expandedFolders.delete(folderId);
      }
    }
    
    function restoreExpandedState() {
      expandedFolders.forEach(folderId => {
        const filesDiv = document.getElementById('files-' + folderId);
        const icon = document.getElementById('icon-' + folderId);
        if (filesDiv && icon) {
          filesDiv.classList.add('expanded');
          icon.classList.add('expanded');
        }
      });
    }
    
    function showStatus(message) {
      const statusIndicator = document.querySelector('.status-indicator');
      if (statusIndicator) {
        statusIndicator.textContent = message;
        statusIndicator.classList.add('show');
        setTimeout(() => {
          statusIndicator.classList.remove('show');
        }, 2000);
      }
    }
    
    function checkForUpdates() {
      fetch('/check-updates?hash=' + currentHash)
        .then(response => response.json())
        .then(data => {
          if (data.updated) {
            currentHash = data.hash;
            // Reload the file list
            fetch(window.location.href)
              .then(response => response.text())
              .then(html => {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const newContent = doc.querySelector('.files-container');
                const currentContent = document.querySelector('.files-container');
                if (newContent && currentContent) {
                  currentContent.innerHTML = newContent.innerHTML;
                  restoreExpandedState();
                  showStatus('● Updated');
                }
              });
          }
        })
        .catch(error => {
          console.error('Error checking for updates:', error);
        });
    }
    
    // Check for updates every 2 seconds
    document.addEventListener('DOMContentLoaded', function() {
      checkInterval = setInterval(checkForUpdates, 2000);
    });
    
    // Clean up interval when page is unloaded
    window.addEventListener('beforeunload', function() {
      if (checkInterval) {
        clearInterval(checkInterval);
      }
    });
  </script>
</head>
<body>
  <div class="status-indicator">● Connected</div>
  
  <header>
    <img src="{{ url_for('logo') }}" alt="Logo" />
  </header>
  
  <div class="upload-section">
    <div class="auto-delete-info">
      ⚠️ Files are automatically deleted after 30 days
    </div>
    
    <div class="upload-option">
      <h3>Upload Files</h3>
      <form method="post" enctype="multipart/form-data" action="{{ url_for('upload_files') }}">
        <input type="file" name="files" multiple required>
        <input type="submit" value="Upload Files">
      </form>
    </div>
    
    <div class="upload-option">
      <h3>Upload Folder</h3>
      <form method="post" enctype="multipart/form-data" action="{{ url_for('upload_folder') }}">
        <input type="file" name="files" webkitdirectory directory multiple required>
        <input type="submit" value="Upload Folder">
      </form>
    </div>
  </div>
  
  <div class="files-container">
  {% if date_groups %}
    {% for date_label in date_groups_sorted %}
      {% set date_data = date_groups[date_label] %}
      <div class="date-section">
        <div class="date-header">📅 {{ date_label }}</div>
        <ul>
        {% if date_data.folders or date_data.files %}
          {% for folder_name, folder_files in date_data.folders.items() %}
          <li class="folder-item">
            <div class="folder-header" onclick="toggleFolder('{{ date_label }}-{{ loop.index }}')">
              <div class="folder-name">
                <span class="toggle-icon" id="icon-{{ date_label }}-{{ loop.index }}">▶</span>
                <span class="folder-icon">📁</span>
                <span>{{ folder_name }} ({{ folder_files|length }} files)</span>
              </div>
              <div class="actions">
                <form method="get" action="{{ url_for('download_folder', folder_name=folder_name) }}" style="display: inline;">
                  <button type="submit" class="download-button">Download ZIP</button>
                </form>
                <form class="delete-form" method="post" action="{{ url_for('delete_folder', folder_name=folder_name) }}" onsubmit="return confirm('Delete folder {{ folder_name }} and all its contents?');">
                  <button type="submit" class="delete-button">Delete</button>
                </form>
              </div>
            </div>
            <div class="folder-files" id="files-{{ date_label }}-{{ loop.index }}">
              {% for file in folder_files %}
              <div class="folder-file">📄 {{ file }}</div>
              {% endfor %}
            </div>
          </li>
          {% endfor %}
          
          {% for filename in date_data.files %}
          <li>
            <div class="item">
              <div class="file-info">
                <a href="{{ url_for('uploaded_file', filename=filename) }}">📄 {{ filename }}</a>
              </div>
              <form class="delete-form" method="post" action="{{ url_for('delete_file', filename=filename) }}" onsubmit="return confirm('Delete {{ filename }}?');">
                <button type="submit" class="delete-button">Delete</button>
              </form>
            </div>
          </li>
          {% endfor %}
        {% else %}
          <li class="no-files">No files for this date</li>
        {% endif %}
        </ul>
      </div>
    {% endfor %}
  {% else %}
    <div class="no-files">No files uploaded yet</div>
  {% endif %}
  </div>
</body>
</html>'''

def generate_unique_folder_name(base_name):
    """Generate a unique folder name by appending timestamp if needed"""
    folder_path = os.path.join(UPLOAD_FOLDER, base_name)
    if not os.path.exists(folder_path):
        return base_name
    
    # Add timestamp to make it unique
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{base_name}_{timestamp}"

@app.route('/')
def index():
    date_groups = get_files_by_date()
    current_hash = get_folder_hash()
    
    # Sort date groups: Today, Yesterday, then by date (newest first)
    def sort_key(date_label):
        if date_label == "Today":
            return (0, "")
        elif date_label == "Yesterday":
            return (1, "")
        else:
            # Parse the date and sort in reverse
            try:
                date_obj = datetime.strptime(date_label, "%B %d, %Y")
                return (2, -date_obj.timestamp())
            except:
                return (3, date_label)
    
    date_groups_sorted = sorted(date_groups.keys(), key=sort_key)
    
    return render_template_string(HTML, 
                                 date_groups=date_groups, 
                                 date_groups_sorted=date_groups_sorted,
                                 current_hash=current_hash)

@app.route('/check-updates')
def check_updates():
    """Check if files have been updated"""
    client_hash = request.args.get('hash', '')
    current_hash = get_folder_hash()
    
    return jsonify({
        'updated': client_hash != current_hash,
        'hash': current_hash
    })

@app.route('/upload-files', methods=['POST'])
def upload_files():
    files = request.files.getlist('files')
    
    if len(files) == 1:
        # Single file - save directly
        file = files[0]
        if file and file.filename:
            file_path = os.path.join(UPLOAD_FOLDER, os.path.basename(file.filename))
            file.save(file_path)
    else:
        # Multiple files - create a folder
        first_filename = os.path.splitext(os.path.basename(files[0].filename))[0]
        folder_name = generate_unique_folder_name(f"Multiple_Files_{first_filename}")
        folder_path = os.path.join(UPLOAD_FOLDER, folder_name)
        os.makedirs(folder_path, exist_ok=True)
        
        for file in files:
            if file and file.filename:
                file_path = os.path.join(folder_path, os.path.basename(file.filename))
                file.save(file_path)
    
    return redirect(url_for('index'))

@app.route('/upload-folder', methods=['POST'])
def upload_folder():
    files = request.files.getlist('files')
    if not files:
        return redirect(url_for('index'))
    
    # Extract all unique root folders from the uploaded files
    root_folders = set()
    for file in files:
        if file.filename:
            parts = file.filename.replace('\\', '/').split('/')
            if len(parts) > 1:
                root_folders.add(parts[0])
    
    if len(root_folders) == 1:
        # Single folder - preserve original structure
        for file in files:
            if file and file.filename:
                file_path = os.path.join(UPLOAD_FOLDER, file.filename.replace('\\', '/'))
                os.makedirs(os.path.dirname(file_path), exist_ok=True)
                file.save(file_path)
    else:
        # Multiple folders - create a "Multiple_Folders" container
        first_folder = list(root_folders)[0] if root_folders else "upload"
        folder_name = generate_unique_folder_name(f"Multiple_Folders_{first_folder}")
        folder_path = os.path.join(UPLOAD_FOLDER, folder_name)
        os.makedirs(folder_path, exist_ok=True)
        
        for file in files:
            if file and file.filename:
                # Preserve the internal structure within the Multiple_Folders container
                file_path = os.path.join(folder_path, file.filename.replace('\\', '/'))
                os.makedirs(os.path.dirname(file_path), exist_ok=True)
                file.save(file_path)
    
    return redirect(url_for('index'))

@app.route('/download-folder/<path:folder_name>')
def download_folder(folder_name):
    folder_path = os.path.join(UPLOAD_FOLDER, folder_name)
    
    if not os.path.exists(folder_path):
        return "Folder not found", 404
    
    # Create zip file in memory
    memory_file = BytesIO()
    with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(folder_path):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, folder_path)
                zf.write(file_path, arcname)
    
    memory_file.seek(0)
    return send_file(
        memory_file,
        mimetype='application/zip',
        as_attachment=True,
        download_name=f'{folder_name}.zip'
    )

@app.route('/logo.png')
def logo():
    return send_from_directory('.', 'logo.png')

@app.route('/uploads/<path:filename>')
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)

@app.route('/delete/<path:filename>', methods=['POST'])
def delete_file(filename):
    file_path = os.path.join(UPLOAD_FOLDER, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
    return redirect(url_for('index'))

@app.route('/delete-folder/<path:folder_name>', methods=['POST'])
def delete_folder(folder_name):
    folder_path = os.path.join(UPLOAD_FOLDER, folder_name)
    if os.path.exists(folder_path) and os.path.isdir(folder_path):
        import shutil
        shutil.rmtree(folder_path)
    return redirect(url_for('index'))

if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000, threaded=True)