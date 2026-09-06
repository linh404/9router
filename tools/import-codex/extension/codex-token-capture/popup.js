'use strict';

const statusEl = document.getElementById('status');
const startButton = document.getElementById('start');
const showLogsButton = document.getElementById('showLogs');
const logsEl = document.getElementById('logs');

function render(status) {
  if (!status) return;
  statusEl.textContent = status.email ? `${status.message}\n${status.email}` : status.message;
}

async function renderLogs() {
  const logs = await chrome.runtime.sendMessage({ type: 'get_logs' });
  logsEl.textContent = (logs || []).map((entry) => {
    const details = JSON.stringify(entry.details || {});
    return `${entry.at} ${entry.event} ${details}`;
  }).join('\n');
  logsEl.style.display = 'block';
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'start_oauth' });
  if (!result || !result.ok) {
    statusEl.textContent = `Lỗi: ${result && result.error ? result.error : 'unknown_error'}`;
    startButton.disabled = false;
    return;
  }
  statusEl.textContent = 'Đã mở tab ẩn danh. Mày tự đăng nhập và nhập 2FA.';
});

showLogsButton.addEventListener('click', renderLogs);

chrome.runtime.sendMessage({ type: 'get_status' }).then(render);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.codexCaptureStatus) render(changes.codexCaptureStatus.newValue);
});
