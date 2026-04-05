---
name: wechat-send-image
description: Send an image or screenshot to WeChat. Use when the user wants to send a picture, screenshot, or photo to WeChat.
argument-hint: "[image file path]"
---

# Send Image to WeChat

Send an image file to WeChat. The image will be displayed inline in the WeChat conversation.

## Arguments

$ARGUMENTS contains the image file path. If not provided, look for recent screenshots or ask the user.

## Steps

### 1. Resolve Image Path

If $ARGUMENTS is provided, use it directly. Otherwise:
- Check for recent screenshots on the Desktop: `ls -t ~/Desktop/ScreenShot_* | head -5`
- Ask the user which image to send

### 2. Validate Image

```
Use the Bash tool to run: ls -la "$ARGUMENTS"
```

Supported formats: jpg, jpeg, png, gif, bmp, webp

### 3. Send Image

```
Use the Bash tool to run:
node -e "
fetch('http://localhost:3100/api/wechat/send-file', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer $TEAMMCP_KEY' },
  body: JSON.stringify({ file_path: '$ARGUMENTS' })
}).then(r=>r.json()).then(d => {
  if (d.ok) console.log('Image sent:', d.fileName, '(' + d.size + ' bytes)');
  else console.error('Failed:', d.error);
});
"
```

### 4. Report Result

Confirm the image was sent successfully.

## Technical Details

- Images are encrypted with AES-128-ECB before upload
- Uploaded to WeChat CDN (novac2c.cdn.weixin.qq.com)
- Sent as `image_item` with `encrypt_type: 1` and `mid_size` (ciphertext size)
- WeChat displays the image inline in the conversation
