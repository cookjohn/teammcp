---
name: wechat-send-file
description: Send a file or image to WeChat via TeamMCP. Use when the user wants to send a file, image, or document to WeChat.
argument-hint: "[file path]"
---

# Send File to WeChat

Send a local file (image, document, video) to WeChat via the TeamMCP WeChat bridge.

## Arguments

$ARGUMENTS contains the file path to send. If not provided, ask the user which file to send.

## Steps

### 1. Validate File

Check the file exists and get its size:

```
Use the Bash tool to run: ls -la "$ARGUMENTS"
```

If the file doesn't exist, tell the user and ask for a correct path.

### 2. Check WeChat Connection

Call the TeamMCP API to verify WeChat is connected:

```
Use the Bash tool to run:
curl -s http://localhost:3100/api/wechat/status -H "Authorization: Bearer $TEAMMCP_KEY"
```

If `connected` is false, tell the user to connect WeChat first via the Dashboard.

### 3. Send File

Call the send-file API:

```
Use the Bash tool to run:
node -e "
fetch('http://localhost:3100/api/wechat/send-file', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer $TEAMMCP_KEY' },
  body: JSON.stringify({ file_path: '$ARGUMENTS' })
}).then(r=>r.json()).then(d => {
  if (d.ok) console.log('File sent:', d.fileName, '(' + d.size + ' bytes)');
  else console.error('Failed:', d.error);
});
"
```

### 4. Report Result

Tell the user whether the file was sent successfully, including the filename and size.

## Supported File Types

| Type | Extensions | WeChat Display |
|------|-----------|----------------|
| Image | jpg, jpeg, png, gif, bmp, webp | Inline image |
| Video | mp4, avi, mov, wmv, mkv | Video player |
| File | All others (pdf, doc, md, txt, etc.) | File attachment |

## How It Works

1. File is encrypted with AES-128-ECB (random key)
2. Encrypted data is uploaded to WeChat CDN via `getuploadurl` + POST
3. CDN returns a download parameter
4. `sendmessage` sends the media reference to the WeChat user

## Prerequisites

- WeChat bridge must be connected (scan QR code via Dashboard)
- A recent WeChat message from the user is needed (provides context_token, valid 24h)
