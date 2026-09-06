'use strict';

const query = new URLSearchParams(location.search);
const title = document.getElementById('title');
const message = document.getElementById('message');
const stage = query.get('stage');

if (stage === 'success') {
  title.textContent = 'Đăng nhập thành công';
  message.textContent = query.get('email')
    ? `Đã lấy token cho ${query.get('email')} và mở hộp thoại tải file JSON.`
    : 'Đã lấy token và mở hộp thoại tải file JSON.';
} else if (stage === 'error') {
  title.textContent = 'OAuth thất bại';
  title.className = 'error';
  message.textContent = query.get('message') || 'Không lấy được token.';
} else if (stage === 'processing') {
  title.textContent = 'Đã nhận callback';
  message.textContent = 'Đang lấy token mới...';
}
