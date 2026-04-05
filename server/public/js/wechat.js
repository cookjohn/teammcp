let wechatStatus = 'unknown'; // 'connected', 'disconnected', 'scanning', 'unknown'
let wechatPollTimer = null;

async function initWechatPanel() {
  var panel = document.getElementById('wechat-panel');
  if (!panel) return;
  try {
    var res = await fetch('/api/wechat/status', { headers: { 'Authorization': 'Bearer ' + API_KEY } });
    if (res.ok) {
      var data = await res.json();
      wechatStatus = data.connected ? 'connected' : 'disconnected';
    } else {
      wechatStatus = 'disconnected';
    }
  } catch (e) {
    wechatStatus = 'disconnected';
  }
  renderWechatPanel();
}

function renderWechatPanel() {
  var panel = document.getElementById('wechat-panel');
  if (!panel) return;
  var html = '';

  // Status display
  var dotClass = wechatStatus === 'connected' ? 'connected' : 'disconnected';
  var statusText = wechatStatus === 'connected' ? i18n.t('wechat.connected') :
                   wechatStatus === 'scanning' ? i18n.t('wechat.scanning') :
                   i18n.t('wechat.disconnected');
  html += '<div class="wechat-status">';
  html += '<span class="status-dot ' + dotClass + '"></span>';
  html += '<span>' + statusText + '</span>';
  html += '</div>';

  if (wechatStatus === 'connected') {
    html += '<button class="wechat-btn disconnect" onclick="disconnectWechat()">' + i18n.t('wechat.disconnect') + '</button>';
  } else if (wechatStatus === 'scanning') {
    html += '<div class="wechat-qr" id="wechat-qr"></div>';
    html += '<button class="wechat-btn" onclick="cancelWechatLogin()">' + i18n.t('wechat.cancel') + '</button>';
  } else {
    html += '<button class="wechat-btn connect" onclick="startWechatLogin()">' + i18n.t('wechat.bind') + '</button>';
  }

  panel.innerHTML = html;
}

async function startWechatLogin() {
  try {
    var res = await fetch('/api/wechat/login', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    if (!res.ok) throw new Error('Failed');
    var data = await res.json();
    wechatStatus = 'scanning';
    renderWechatPanel();

    // Show QR code
    var qrContainer = document.getElementById('wechat-qr');
    var qrData = data.qrcode_img_content || data.qr_url || '';
    if (qrContainer && qrData) {
      var imgSrc;
      if (qrData.startsWith('data:')) {
        // Already a data URI
        imgSrc = qrData;
      } else if (qrData.startsWith('http')) {
        // URL — generate QR code image via third-party API
        imgSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(qrData);
      } else {
        // Assume base64 image data
        imgSrc = 'data:image/png;base64,' + qrData;
      }
      qrContainer.innerHTML = '<img src="' + escapeHtml(imgSrc) + '" alt="QR Code">' +
        '<div class="wechat-qr-hint">' + i18n.t('wechat.scanHint') + '</div>';
    }

    // Start polling for scan status
    startWechatPoll();
  } catch (e) {
    alert(i18n.t('wechat.bindFailed') + ': ' + e.message);
  }
}

function startWechatPoll() {
  if (wechatPollTimer) clearInterval(wechatPollTimer);
  wechatPollTimer = setInterval(async function() {
    try {
      var res = await fetch('/api/wechat/status', { headers: { 'Authorization': 'Bearer ' + API_KEY } });
      if (res.ok) {
        var data = await res.json();
        if (data.connected) {
          wechatStatus = 'connected';
          clearInterval(wechatPollTimer);
          wechatPollTimer = null;
          renderWechatPanel();
        }
      }
    } catch (e) {}
  }, 3000);
}

function cancelWechatLogin() {
  wechatStatus = 'disconnected';
  if (wechatPollTimer) { clearInterval(wechatPollTimer); wechatPollTimer = null; }
  renderWechatPanel();
}

async function disconnectWechat() {
  if (!confirm(i18n.t('wechat.confirmDisconnect'))) return;
  try {
    await fetch('/api/wechat/disconnect', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    wechatStatus = 'disconnected';
    renderWechatPanel();
  } catch (e) {
    alert(i18n.t('wechat.disconnectFailed'));
  }
}