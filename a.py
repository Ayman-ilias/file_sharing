from flask import Flask, request, render_template_string, send_from_directory, redirect, url_for
import os

app = Flask(__name__)
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

HTML = '''
<!doctype html>
<html>
<head>
  <title>File Upload</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 40px auto;
      max-width: 600px;
      background: #f4f7f8;
      color: #333;
    }
    h1, h2 {
      color: #4a90e2;
    }
    form {
      background: #fff;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 5px #ccc;
      margin-bottom: 30px;
    }
    input[type=file] {
      margin-bottom: 10px;
    }
    input[type=submit] {
      background: #4a90e2;
      color: white;
      border: none;
      padding: 8px 15px;
      border-radius: 4px;
      cursor: pointer;
    }
    input[type=submit]:hover {
      background: #357ABD;
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
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 1px 3px #ddd;
    }
    a {
      color: #4a90e2;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    form.delete-form {
      margin: 0;
    }
    button.delete-button {
      background: #e74c3c;
      border: none;
      color: white;
      padding: 5px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9em;
    }
    button.delete-button:hover {
      background: #c0392b;
    }
  </style>
</head>
<body>
  <h1>Upload a file</h1>
  <form method="post" enctype="multipart/form-data">
    <input type="file" name="file" required>
    <input type="submit" value="Upload">
  </form>

  <h2>Files:</h2>
  <ul>
  {% for filename in files %}
    <li>
      <a href="{{ url_for('uploaded_file', filename=filename) }}">{{ filename }}</a>
      <form class="delete-form" method="post" action="{{ url_for('delete_file', filename=filename) }}" onsubmit="return confirm('Delete {{ filename }}?');">
        <button type="submit" class="delete-button">Delete</button>
      </form>
    </li>
  {% else %}
    <li>No files uploaded yet</li>
  {% endfor %}
  </ul>
</body>
</html>
'''

@app.route('/', methods=['GET', 'POST'])
def index():
    if request.method == 'POST':
        f = request.files.get('file')
        if f and f.filename:
            f.save(os.path.join(UPLOAD_FOLDER, f.filename))
        return redirect(url_for('index'))
    files = os.listdir(UPLOAD_FOLDER)
    return render_template_string(HTML, files=files)

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)

@app.route('/delete/<filename>', methods=['POST'])
def delete_file(filename):
    file_path = os.path.join(UPLOAD_FOLDER, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
    return redirect(url_for('index'))

if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000)
