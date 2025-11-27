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
        time.sleep(3600)


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
        return file_date_only.strftime("%B %d, %Y")


def get_files_by_date():
    """Organize files by date groups"""
    date_groups = {}
    
    if not os.path.exists(UPLOAD_FOLDER):
        return date_groups
    
    for item in os.listdir(UPLOAD_FOLDER):
        item_path = os.path.join(UPLOAD_FOLDER, item)
        
        creation_time = datetime.fromtimestamp(os.path.getctime(item_path))
        date_label = get_date_label(creation_time)
        
        if date_label not in date_groups:
            date_groups[date_label] = {'folders': {}, 'files': []}
        
        if os.path.isdir(item_path):
            folder_files = []
            for root, dirs, files in os.walk(item_path):
                for filename in files:
                    rel_path = os.path.relpath(os.path.join(root, filename), item_path)
                    folder_files.append(rel_path)
            date_groups[date_label]['folders'][item] = sorted(folder_files)
        else:
            date_groups[date_label]['files'].append(item)
    
    for date_label in date_groups:
        date_groups[date_label]['files'].sort()
    
    return date_groups


def format_file_size(size_bytes):
    """Convert bytes to human readable format"""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.1f} TB"


def get_file_size(filename):
    """Get file size"""
    try:
        file_path = os.path.join(UPLOAD_FOLDER, filename)
        return format_file_size(os.path.getsize(file_path))
    except:
        return "Unknown"


HTML = '''<!doctype html>
<html><head>
  <title>Southern IoT - File Sharing Platform</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    :root {
      --primary: #667eea;
      --primary-dark: #5568d3;
      --secondary: #764ba2;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --info: #3b82f6;
      --text-dark: #1f2937;
      --text-light: #6b7280;
      --glass-bg: rgba(255, 255, 255, 0.85);
      --glass-border: rgba(255, 255, 255, 0.3);
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.08);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.1);
      --shadow-lg: 0 10px 30px rgba(0,0,0,0.12);
      --shadow-xl: 0 20px 50px rgba(0,0,0,0.15);
    }
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      background-attachment: fixed;
      min-height: 100vh;
      padding: 20px;
      color: var(--text-dark);
      position: relative;
      overflow-x: hidden;
    }
    
    /* Animated background particles */
    .bg-particles {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 0;
    }
    
    .particle {
      position: absolute;
      background: rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      animation: float 20s infinite ease-in-out;
    }
    
    @keyframes float {
      0%, 100% { transform: translateY(0) translateX(0); }
      25% { transform: translateY(-100px) translateX(50px); }
      50% { transform: translateY(-200px) translateX(-50px); }
      75% { transform: translateY(-100px) translateX(100px); }
    }
    
    .container {
      max-width: 1000px;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }
    
    /* Glassmorphism styles */
    .glass {
      background: var(--glass-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--glass-border);
      box-shadow: var(--shadow-xl);
    }
    
    .glass-light {
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    
    header {
      text-align: center;
      margin-bottom: 40px;
      animation: fadeInDown 0.8s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .logo-container {
      position: relative;
      display: inline-block;
      margin-bottom: 20px;
    }
    
    header img {
      height: 110px;
      max-width: 90%;
      filter: drop-shadow(0 8px 16px rgba(0,0,0,0.2));
      animation: logoFloat 3s ease-in-out infinite;
    }
    
    @keyframes logoFloat {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }
    
    .header-title {
      color: white;
      font-size: 2.5em;
      font-weight: 800;
      text-shadow: 0 4px 12px rgba(0,0,0,0.3);
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }
    
    .header-subtitle {
      color: rgba(255,255,255,0.95);
      font-size: 1.1em;
      font-weight: 500;
      text-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    
    .info-banner {
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0.85) 100%);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      color: var(--text-dark);
      padding: 18px 24px;
      border-radius: 16px;
      margin-bottom: 30px;
      display: flex;
      align-items: center;
      gap: 15px;
      border: 1px solid rgba(255, 255, 255, 0.5);
      box-shadow: var(--shadow-lg);
      animation: fadeIn 1s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .info-banner .icon {
      font-size: 28px;
      flex-shrink: 0;
      animation: pulse 2s ease-in-out infinite;
    }
    
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); }
    }
    
    .info-banner .text {
      flex-grow: 1;
      font-size: 0.95em;
      line-height: 1.6;
    }
    
    .info-banner strong {
      color: var(--warning);
      font-weight: 700;
    }
    
    .upload-container {
      background: var(--glass-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 35px;
      margin-bottom: 35px;
      border: 1px solid var(--glass-border);
      box-shadow: var(--shadow-xl);
      animation: fadeInUp 0.8s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .upload-tabs {
      display: flex;
      gap: 12px;
      margin-bottom: 30px;
      border-bottom: 2px solid rgba(0, 0, 0, 0.08);
      padding-bottom: 0;
    }
    
    .upload-tab {
      padding: 14px 24px;
      border: none;
      background: transparent;
      color: var(--text-light);
      font-size: 1em;
      font-weight: 600;
      cursor: pointer;
      border-bottom: 3px solid transparent;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      top: 2px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .upload-tab:hover {
      color: var(--primary);
      background: rgba(102, 126, 234, 0.08);
      border-radius: 12px 12px 0 0;
      transform: translateY(-2px);
    }
    
    .upload-tab.active {
      color: var(--primary);
      border-bottom-color: var(--primary);
      font-weight: 700;
    }
    
    .upload-tab .emoji {
      font-size: 1.2em;
    }
    
    .upload-content {
      display: none;
      animation: fadeIn 0.5s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .upload-content.active {
      display: block;
    }
    
    .upload-area {
      border: 3px dashed rgba(102, 126, 234, 0.3);
      border-radius: 16px;
      padding: 50px 30px;
      text-align: center;
      background: linear-gradient(135deg, rgba(102, 126, 234, 0.03) 0%, rgba(118, 75, 162, 0.03) 100%);
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      position: relative;
      overflow: hidden;
    }
    
    .upload-area::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(102, 126, 234, 0.1) 0%, transparent 70%);
      opacity: 0;
      transition: opacity 0.4s ease;
    }
    
    .upload-area:hover::before {
      opacity: 1;
    }
    
    .upload-area:hover, .upload-area.dragover {
      border-color: var(--primary);
      background: linear-gradient(135deg, rgba(102, 126, 234, 0.08) 0%, rgba(118, 75, 162, 0.08) 100%);
      transform: translateY(-4px) scale(1.01);
      box-shadow: 0 12px 24px rgba(102, 126, 234, 0.2);
    }
    
    .upload-area.dragover {
      border-style: solid;
      border-width: 3px;
    }
    
    .upload-area .icon {
      font-size: 56px;
      margin-bottom: 20px;
      display: inline-block;
      animation: bounce 2s ease-in-out infinite;
    }
    
    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }
    
    .upload-area:hover .icon {
      animation: shake 0.5s ease-in-out;
    }
    
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-10px); }
      75% { transform: translateX(10px); }
    }
    
    .upload-area .title {
      font-size: 1.3em;
      font-weight: 700;
      color: var(--text-dark);
      margin-bottom: 10px;
    }
    
    .upload-area .subtitle {
      color: var(--text-light);
      font-size: 1em;
      margin-bottom: 20px;
      font-weight: 500;
    }
    
    .upload-area input[type="file"] {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      cursor: pointer;
    }
    
    .file-selected-indicator {
      display: none;
      margin-top: 15px;
      padding: 12px 20px;
      background: linear-gradient(135deg, var(--success) 0%, #059669 100%);
      color: white;
      border-radius: 10px;
      font-weight: 600;
      animation: slideInUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .file-selected-indicator.show {
      display: block;
    }
    
    @keyframes slideInUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    .btn-primary {
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: white;
      border: none;
      padding: 14px 36px;
      border-radius: 12px;
      font-size: 1.05em;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 6px 16px rgba(102, 126, 234, 0.4);
      margin-top: 20px;
      position: relative;
      overflow: hidden;
    }
    
    .btn-primary::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 0;
      height: 0;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.3);
      transform: translate(-50%, -50%);
      transition: width 0.6s, height 0.6s;
    }
    
    .btn-primary:hover::before {
      width: 300px;
      height: 300px;
    }
    
    .btn-primary:hover {
      transform: translateY(-3px);
      box-shadow: 0 10px 24px rgba(102, 126, 234, 0.5);
    }
    
    .btn-primary:active {
      transform: translateY(-1px);
    }
    
    .form-group {
      margin-bottom: 24px;
      text-align: left;
    }
    
    .form-label {
      display: block;
      margin-bottom: 10px;
      font-weight: 700;
      color: var(--text-dark);
      font-size: 0.95em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .form-input {
      width: 100%;
      padding: 14px 18px;
      border: 2px solid rgba(0, 0, 0, 0.1);
      border-radius: 12px;
      font-size: 1em;
      font-family: inherit;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      background: white;
    }
    
    .form-input:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.15);
      transform: translateY(-2px);
    }
    
    textarea.form-input {
      min-height: 180px;
      resize: vertical;
      font-family: 'Inter', sans-serif;
      line-height: 1.6;
    }
    
    .char-counter {
      text-align: right;
      font-size: 0.85em;
      color: var(--text-light);
      margin-top: 8px;
      font-weight: 600;
    }
    
    .files-section {
      animation: fadeInUp 1s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .date-section {
      margin-bottom: 35px;
    }
    
    .date-header {
      background: var(--glass-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      color: var(--primary);
      padding: 18px 26px;
      border-radius: 16px;
      font-size: 1.3em;
      font-weight: 800;
      margin-bottom: 18px;
      border: 1px solid var(--glass-border);
      box-shadow: var(--shadow-md);
      display: flex;
      align-items: center;
      gap: 12px;
      transition: all 0.3s ease;
    }
    
    .date-header:hover {
      transform: translateX(5px);
      box-shadow: var(--shadow-lg);
    }
    
    .file-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .file-item {
      background: white;
      padding: 18px 24px;
      border-radius: 16px;
      box-shadow: var(--shadow-sm);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 18px;
      border: 1px solid rgba(0, 0, 0, 0.05);
      position: relative;
      overflow: hidden;
    }
    
    .file-item::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      height: 100%;
      width: 4px;
      background: linear-gradient(180deg, var(--primary) 0%, var(--secondary) 100%);
      transform: translateX(-4px);
      transition: transform 0.3s ease;
    }
    
    .file-item:hover::before {
      transform: translateX(0);
    }
    
    .file-item:hover {
      transform: translateX(8px);
      box-shadow: var(--shadow-md);
      border-color: rgba(102, 126, 234, 0.2);
    }
    
    .file-item.folder::before {
      background: linear-gradient(180deg, var(--primary) 0%, var(--info) 100%);
    }
    
    .file-item.text::before {
      background: linear-gradient(180deg, var(--warning) 0%, #f59e0b 100%);
    }
    
    .file-icon {
      font-size: 28px;
      flex-shrink: 0;
      transition: transform 0.3s ease;
    }
    
    .file-item:hover .file-icon {
      transform: scale(1.2) rotate(5deg);
    }
    
    .file-info {
      flex-grow: 1;
      min-width: 0;
    }
    
    .file-name {
      font-weight: 700;
      color: var(--text-dark);
      word-break: break-word;
      margin-bottom: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 1.05em;
    }
    
    .file-meta {
      font-size: 0.85em;
      color: var(--text-light);
      font-weight: 600;
    }
    
    .file-actions {
      display: flex;
      gap: 10px;
      flex-shrink: 0;
    }
    
    .btn {
      padding: 10px 18px;
      border: none;
      border-radius: 10px;
      font-size: 0.9em;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      white-space: nowrap;
      position: relative;
      overflow: hidden;
    }
    
    .btn::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 0;
      height: 0;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.4);
      transform: translate(-50%, -50%);
      transition: width 0.6s, height 0.6s;
    }
    
    .btn:hover::after {
      width: 200px;
      height: 200px;
    }
    
    .btn-download {
      background: linear-gradient(135deg, var(--success) 0%, #059669 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
    }
    
    .btn-download:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(16, 185, 129, 0.4);
    }
    
    .btn-delete {
      background: linear-gradient(135deg, var(--danger) 0%, #dc2626 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
    }
    
    .btn-delete:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(239, 68, 68, 0.4);
    }
    
    .btn:active {
      transform: translateY(0);
    }
    
    .folder-contents {
      margin-top: 15px;
      padding-left: 45px;
      display: none;
      animation: slideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .folder-contents.expanded {
      display: block;
    }
    
    .folder-file {
      padding: 10px 0;
      color: var(--text-light);
      font-size: 0.9em;
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 500;
      transition: all 0.2s ease;
    }
    
    .folder-file:hover {
      color: var(--primary);
      transform: translateX(5px);
    }
    
    .text-preview {
      margin-top: 15px;
      padding: 18px;
      background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%);
      border-radius: 12px;
      font-family: 'Courier New', monospace;
      font-size: 0.9em;
      white-space: pre-wrap;
      word-wrap: break-word;
      max-height: 350px;
      overflow-y: auto;
      border: 2px solid rgba(0, 0, 0, 0.08);
      display: none;
      line-height: 1.6;
    }
    
    .text-preview.expanded {
      display: block;
      animation: slideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .text-preview::-webkit-scrollbar {
      width: 8px;
    }
    
    .text-preview::-webkit-scrollbar-track {
      background: rgba(0, 0, 0, 0.05);
      border-radius: 10px;
    }
    
    .text-preview::-webkit-scrollbar-thumb {
      background: var(--primary);
      border-radius: 10px;
    }
    
    .toggle-icon {
      display: inline-block;
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      font-size: 0.85em;
      color: var(--primary);
      font-weight: bold;
    }
    
    .toggle-icon.expanded {
      transform: rotate(90deg);
    }
    
    .empty-state {
      text-align: center;
      padding: 70px 30px;
      background: var(--glass-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 20px;
      border: 1px solid var(--glass-border);
      box-shadow: var(--shadow-lg);
    }
    
    .empty-state .icon {
      font-size: 72px;
      margin-bottom: 24px;
      opacity: 0.4;
      animation: float 3s ease-in-out infinite;
    }
    
    .empty-state .title {
      font-size: 1.4em;
      font-weight: 700;
      color: var(--text-light);
      margin-bottom: 10px;
    }
    
    .empty-state .subtitle {
      color: var(--text-light);
      font-size: 1em;
    }
    
    .status-indicator {
      position: fixed;
      top: 24px;
      right: 24px;
      padding: 14px 24px;
      border-radius: 12px;
      font-size: 0.9em;
      font-weight: 700;
      background: white;
      color: var(--success);
      box-shadow: var(--shadow-lg);
      opacity: 0;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 1000;
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid rgba(0, 0, 0, 0.08);
    }
    
    .status-indicator.show {
      opacity: 1;
      transform: translateY(0);
    }
    
    .status-indicator.online {
      color: var(--success);
    }
    
    .status-indicator.updated {
      color: var(--primary);
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse-dot 2s ease-in-out infinite;
    }
    
    @keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(1.3); }
    }
    
    .progress-bar {
      display: none;
      margin-top: 15px;
      height: 6px;
      background: rgba(0, 0, 0, 0.1);
      border-radius: 10px;
      overflow: hidden;
    }
    
    .progress-bar.show {
      display: block;
    }
    
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--primary) 0%, var(--secondary) 100%);
      border-radius: 10px;
      transition: width 0.3s ease;
      animation: shimmer 2s infinite;
    }
    
    @keyframes shimmer {
      0% { background-position: -1000px 0; }
      100% { background-position: 1000px 0; }
    }
    
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    @keyframes fadeInDown {
      from {
        opacity: 0;
        transform: translateY(-30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    @keyframes slideDown {
      from {
        opacity: 0;
        max-height: 0;
      }
      to {
        opacity: 1;
        max-height: 1000px;
      }
    }
    
    @media (max-width: 768px) {
      body {
        padding: 12px;
      }
      
      .header-title {
        font-size: 1.8em;
      }
      
      .header-subtitle {
        font-size: 0.95em;
      }
      
      .upload-container {
        padding: 24px;
      }
      
      .upload-tabs {
        flex-wrap: wrap;
      }
      
      .upload-tab {
        flex: 1;
        min-width: 100px;
        font-size: 0.9em;
        padding: 12px 16px;
      }
      
      .upload-area {
        padding: 40px 20px;
      }
      
      .file-item {
        flex-direction: column;
        align-items: flex-start;
        padding: 16px;
      }
      
      .file-actions {
        width: 100%;
        justify-content: flex-end;
      }
      
      .btn {
        flex: 1;
        font-size: 0.85em;
        padding: 8px 14px;
      }
      
      .status-indicator {
        top: 12px;
        right: 12px;
        padding: 10px 16px;
        font-size: 0.85em;
      }
    }
    
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
  <script>
    let expandedItems = new Set();
    let currentHash = '{{ current_hash }}';
    let checkInterval;
    let currentTab = 'text';
    
    function createParticles() {
      const container = document.querySelector('.bg-particles');
      const particleCount = 15;
      
      for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.width = Math.random() * 50 + 20 + 'px';
        particle.style.height = particle.style.width;
        particle.style.left = Math.random() * 100 + '%';
        particle.style.top = Math.random() * 100 + '%';
        particle.style.animationDelay = Math.random() * 20 + 's';
        particle.style.animationDuration = (Math.random() * 10 + 15) + 's';
        container.appendChild(particle);
      }
    }
    
    function switchTab(tabName) {
      document.querySelectorAll('.upload-tab').forEach(tab => {
        tab.classList.remove('active');
      });
      document.querySelectorAll('.upload-content').forEach(content => {
        content.classList.remove('active');
      });
      
      document.getElementById('tab-' + tabName).classList.add('active');
      document.getElementById('content-' + tabName).classList.add('active');
      currentTab = tabName;
    }
    
    function toggleItem(itemId) {
      const content = document.getElementById('content-' + itemId);
      const icon = document.getElementById('icon-' + itemId);
      
      if (content && icon) {
        content.classList.toggle('expanded');
        icon.classList.toggle('expanded');
        
        if (content.classList.contains('expanded')) {
          expandedItems.add(itemId);
        } else {
          expandedItems.delete(itemId);
        }
      }
    }
    
    function restoreExpandedState() {
      expandedItems.forEach(itemId => {
        const content = document.getElementById('content-' + itemId);
        const icon = document.getElementById('icon-' + itemId);
        if (content && icon) {
          content.classList.add('expanded');
          icon.classList.add('expanded');
        }
      });
    }
    
    function updateCharCount(textarea) {
      const counter = textarea.parentElement.querySelector('.char-counter');
      if (counter) {
        const count = textarea.value.length;
        counter.textContent = count.toLocaleString() + ' characters';
        
        if (count > 0) {
          counter.style.color = 'var(--primary)';
        } else {
          counter.style.color = 'var(--text-light)';
        }
      }
    }
    
    function handleFileSelect(input) {
      const indicator = input.closest('.upload-area').querySelector('.file-selected-indicator');
      if (input.files && input.files.length > 0) {
        if (indicator) {
          const count = input.files.length;
          indicator.textContent = `✓ ${count} file${count > 1 ? 's' : ''} selected`;
          indicator.classList.add('show');
        }
      } else {
        if (indicator) {
          indicator.classList.remove('show');
        }
      }
    }
    
    function showStatus(message, type = 'updated') {
      const indicator = document.querySelector('.status-indicator');
      if (indicator) {
        indicator.innerHTML = `<span class="status-dot"></span><span>${message}</span>`;
        indicator.className = 'status-indicator show ' + type;
        setTimeout(() => {
          indicator.classList.remove('show');
        }, 3000);
      }
    }
    
    function checkForUpdates() {
      fetch('/check-updates?hash=' + currentHash)
        .then(response => response.json())
        .then(data => {
          if (data.updated) {
            currentHash = data.hash;
            fetch(window.location.href)
              .then(response => response.text())
              .then(html => {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const newContent = doc.querySelector('.files-section');
                const currentContent = document.querySelector('.files-section');
                if (newContent && currentContent) {
                  currentContent.innerHTML = newContent.innerHTML;
                  restoreExpandedState();
                  showStatus('Content Updated', 'updated');
                }
              });
          }
        })
        .catch(error => {
          console.error('Error checking for updates:', error);
        });
    }
    
    function setupDragDrop() {
      const uploadAreas = document.querySelectorAll('.upload-area');
      
      uploadAreas.forEach(area => {
        area.addEventListener('dragover', (e) => {
          e.preventDefault();
          area.classList.add('dragover');
        });
        
        area.addEventListener('dragleave', () => {
          area.classList.remove('dragover');
        });
        
        area.addEventListener('drop', (e) => {
          e.preventDefault();
          area.classList.remove('dragover');
          
          const input = area.querySelector('input[type="file"]');
          if (input && e.dataTransfer.files.length > 0) {
            input.files = e.dataTransfer.files;
            handleFileSelect(input);
          }
        });
        
        const input = area.querySelector('input[type="file"]');
        if (input) {
          input.addEventListener('change', () => handleFileSelect(input));
        }
      });
    }
    
    document.addEventListener('DOMContentLoaded', function() {
      createParticles();
      switchTab(currentTab);
      setupDragDrop();
      checkInterval = setInterval(checkForUpdates, 2000);
      showStatus('Online', 'online');
    });
    
    window.addEventListener('beforeunload', function() {
      if (checkInterval) {
        clearInterval(checkInterval);
      }
    });
  </script>
</head>
<body>
  <div class="bg-particles"></div>
  <div class="status-indicator">Connecting...</div>
  
  <div class="container">
    <header>
      <div class="logo-container">
        <img src="{{ url_for('logo') }}" alt="Southern IoT Logo" />
      </div>
      <div class="header-title">Southern IoT</div>
      <div class="header-subtitle">Professional File & Text Sharing Platform</div>
    </header>
    
    <div class="info-banner">
      <div class="icon">⏱️</div>
      <div class="text">
        <strong>Auto-Delete Policy:</strong> All uploaded content is automatically deleted after 30 days to maintain optimal storage efficiency and security.
      </div>
    </div>
    
    <div class="upload-container">
      <div class="upload-tabs">
        <button class="upload-tab active" id="tab-text" onclick="switchTab('text')">
          <span class="emoji">📝</span> Text
        </button>
        <button class="upload-tab" id="tab-files" onclick="switchTab('files')">
          <span class="emoji">📄</span> Files
        </button>
        <button class="upload-tab" id="tab-folder" onclick="switchTab('folder')">
          <span class="emoji">📁</span> Folder
        </button>
      </div>
      
      <!-- Text Upload -->
      <div class="upload-content active" id="content-text">
        <form method="post" enctype="multipart/form-data" action="{{ url_for('upload_text') }}">
          <div class="form-group">
            <label class="form-label" for="text-title">
              <span>✏️</span> Title (Optional)
            </label>
            <input type="text" id="text-title" name="title" class="form-input" placeholder="Give your text a memorable name...">
          </div>
          
          <div class="form-group">
            <label class="form-label" for="text-content">
              <span>📄</span> Text Content
            </label>
            <textarea id="text-content" name="text_content" class="form-input" placeholder="Type or paste unlimited text here..." required oninput="updateCharCount(this)"></textarea>
            <div class="char-counter">0 characters</div>
          </div>
          
          <button type="submit" class="btn-primary">📤 Upload Text Now</button>
        </form>
      </div>
      
      <!-- Files Upload -->
      <div class="upload-content" id="content-files">
        <form method="post" enctype="multipart/form-data" action="{{ url_for('upload_files') }}">
          <div class="upload-area">
            <div class="icon">📁</div>
            <div class="title">Drag & Drop Files Here</div>
            <div class="subtitle">Or click to browse and select files from your device</div>
            <input type="file" name="files" multiple required>
            <div class="file-selected-indicator"></div>
          </div>
          <button type="submit" class="btn-primary">📤 Upload Selected Files</button>
        </form>
      </div>
      
      <!-- Folder Upload -->
      <div class="upload-content" id="content-folder">
        <form method="post" enctype="multipart/form-data" action="{{ url_for('upload_folder') }}">
          <div class="upload-area">
            <div class="icon">📂</div>
            <div class="title">Drag & Drop a Folder Here</div>
            <div class="subtitle">Folder structure will be preserved automatically</div>
            <input type="file" name="files" webkitdirectory directory multiple required>
            <div class="file-selected-indicator"></div>
          </div>
          <button type="submit" class="btn-primary">📤 Upload Complete Folder</button>
        </form>
      </div>
    </div>
    
    <div class="files-section">
      {% if date_groups %}
        {% for date_label in date_groups_sorted %}
          {% set date_data = date_groups[date_label] %}
          <div class="date-section">
            <div class="date-header">
              <span>📅</span>
              <span>{{ date_label }}</span>
            </div>
            
            {% if date_data.folders or date_data.files %}
              <ul class="file-list">
                <!-- Folders -->
                {% for folder_name, folder_files in date_data.folders.items() %}
                <li class="file-item folder">
                  <div class="file-icon">📁</div>
                  <div class="file-info">
                    <div class="file-name" onclick="toggleItem('folder-{{ date_label }}-{{ loop.index }}')">
                      <span class="toggle-icon" id="icon-folder-{{ date_label }}-{{ loop.index }}">▶</span>
                      <span>{{ folder_name }}</span>
                    </div>
                    <div class="file-meta">{{ folder_files|length }} files inside</div>
                    <div class="folder-contents" id="content-folder-{{ date_label }}-{{ loop.index }}">
                      {% for file in folder_files %}
                      <div class="folder-file">
                        <span>📄</span>
                        <span>{{ file }}</span>
                      </div>
                      {% endfor %}
                    </div>
                  </div>
                  <div class="file-actions">
                    <form method="get" action="{{ url_for('download_folder', folder_name=folder_name) }}" style="display: inline;">
                      <button type="submit" class="btn btn-download">⬇ Download</button>
                    </form>
                    <form method="post" action="{{ url_for('delete_folder', folder_name=folder_name) }}" onsubmit="return confirm('Delete folder \'{{ folder_name }}\' and all its contents?');" style="display: inline;">
                      <button type="submit" class="btn btn-delete">🗑 Delete</button>
                    </form>
                  </div>
                </li>
                {% endfor %}
                
                <!-- Files -->
                {% for filename in date_data.files %}
                <li class="file-item {% if filename.endswith('.txt') %}text{% endif %}">
                  <div class="file-icon">
                    {% if filename.endswith('.txt') %}📝{% else %}📄{% endif %}
                  </div>
                  <div class="file-info">
                    {% if filename.endswith('.txt') %}
                    <div class="file-name" onclick="toggleItem('text-{{ date_label }}-{{ loop.index }}')">
                      <span class="toggle-icon" id="icon-text-{{ date_label }}-{{ loop.index }}">▶</span>
                      <span>{{ filename }}</span>
                    </div>
                    <div class="file-meta">Text Document • {{ get_file_size(filename) }}</div>
                    <div class="text-preview" id="content-text-{{ date_label }}-{{ loop.index }}">{{ get_text_preview(filename) }}</div>
                    {% else %}
                    <a href="{{ url_for('uploaded_file', filename=filename) }}" style="text-decoration: none; color: inherit;">
                      <div class="file-name">{{ filename }}</div>
                    </a>
                    <div class="file-meta">File • {{ get_file_size(filename) }}</div>
                    {% endif %}
                  </div>
                  <div class="file-actions">
                    {% if filename.endswith('.txt') %}
                    <a href="{{ url_for('uploaded_file', filename=filename) }}" download style="text-decoration: none;">
                      <button class="btn btn-download">⬇ Download</button>
                    </a>
                    {% endif %}
                    <form method="post" action="{{ url_for('delete_file', filename=filename) }}" onsubmit="return confirm('Delete \'{{ filename }}\'?');" style="display: inline;">
                      <button type="submit" class="btn btn-delete">🗑 Delete</button>
                    </form>
                  </div>
                </li>
                {% endfor %}
              </ul>
            {% else %}
              <div class="empty-state">
                <div class="icon">📭</div>
                <div class="title">No files for this date</div>
              </div>
            {% endif %}
          </div>
        {% endfor %}
      {% else %}
        <div class="empty-state">
          <div class="icon">📂</div>
          <div class="title">No Uploads Yet</div>
          <div class="subtitle">Start by uploading your first file or text above</div>
        </div>
      {% endif %}
    </div>
  </div>
</body>
</html>'''


def generate_unique_folder_name(base_name):
    """Generate a unique folder name by appending timestamp if needed"""
    folder_path = os.path.join(UPLOAD_FOLDER, base_name)
    if not os.path.exists(folder_path):
        return base_name
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{base_name}_{timestamp}"


def get_text_preview(filename):
    """Get preview of text file content"""
    try:
        file_path = os.path.join(UPLOAD_FOLDER, filename)
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            return content
    except:
        return "Unable to preview file"


@app.route('/')
def index():
    date_groups = get_files_by_date()
    current_hash = get_folder_hash()
    
    def sort_key(date_label):
        if date_label == "Today":
            return (0, "")
        elif date_label == "Yesterday":
            return (1, "")
        else:
            try:
                date_obj = datetime.strptime(date_label, "%B %d, %Y")
                return (2, -date_obj.timestamp())
            except:
                return (3, date_label)
    
    date_groups_sorted = sorted(date_groups.keys(), key=sort_key)
    
    return render_template_string(HTML, 
                                 date_groups=date_groups, 
                                 date_groups_sorted=date_groups_sorted,
                                 current_hash=current_hash,
                                 get_text_preview=get_text_preview,
                                 get_file_size=get_file_size)


@app.route('/check-updates')
def check_updates():
    """Check if files have been updated"""
    client_hash = request.args.get('hash', '')
    current_hash = get_folder_hash()
    
    return jsonify({
        'updated': client_hash != current_hash,
        'hash': current_hash
    })


@app.route('/upload-text', methods=['POST'])
def upload_text():
    """Handle text upload"""
    text_content = request.form.get('text_content', '')
    title = request.form.get('title', '').strip()
    
    if text_content:
        if title:
            safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '_', '-')).strip()
            safe_title = safe_title.replace(' ', '_')
            filename = f"{safe_title}.txt"
        else:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"text_{timestamp}.txt"
        
        file_path = os.path.join(UPLOAD_FOLDER, filename)
        counter = 1
        base_name, ext = os.path.splitext(filename)
        while os.path.exists(file_path):
            filename = f"{base_name}_{counter}{ext}"
            file_path = os.path.join(UPLOAD_FOLDER, filename)
            counter += 1
        
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(text_content)
    
    return redirect(url_for('index'))


@app.route('/upload-files', methods=['POST'])
def upload_files():
    files = request.files.getlist('files')
    
    if len(files) == 1:
        file = files[0]
        if file and file.filename:
            file_path = os.path.join(UPLOAD_FOLDER, os.path.basename(file.filename))
            file.save(file_path)
    else:
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
    
    root_folders = set()
    for file in files:
        if file.filename:
            parts = file.filename.replace('\\', '/').split('/')
            if len(parts) > 1:
                root_folders.add(parts[0])
    
    if len(root_folders) == 1:
        for file in files:
            if file and file.filename:
                file_path = os.path.join(UPLOAD_FOLDER, file.filename.replace('\\', '/'))
                os.makedirs(os.path.dirname(file_path), exist_ok=True)
                file.save(file_path)
    else:
        first_folder = list(root_folders)[0] if root_folders else "upload"
        folder_name = generate_unique_folder_name(f"Multiple_Folders_{first_folder}")
        folder_path = os.path.join(UPLOAD_FOLDER, folder_name)
        os.makedirs(folder_path, exist_ok=True)
        
        for file in files:
            if file and file.filename:
                file_path = os.path.join(folder_path, file.filename.replace('\\', '/'))
                os.makedirs(os.path.dirname(file_path), exist_ok=True)
                file.save(file_path)
    
    return redirect(url_for('index'))


@app.route('/download-folder/<path:folder_name>')
def download_folder(folder_name):
    folder_path = os.path.join(UPLOAD_FOLDER, folder_name)
    
    if not os.path.exists(folder_path):
        return "Folder not found", 404
    
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
