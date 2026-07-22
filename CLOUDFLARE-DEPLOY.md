# Chạy API trên Cloudflare Workers

1. Đăng nhập Cloudflare: `npx wrangler login`
2. Tạo hai secret (không đưa giá trị vào Git):

   `npx wrangler secret put GOOGLE_CREDENTIALS`

   Dán toàn bộ JSON service account đang dùng cho Google Sheets.

   `npx wrangler secret put AUTOMATION_SECRET`

3. Triển khai: `npm run deploy`
4. Wrangler sẽ trả về URL dạng `https://giaoly-tracuu-api.<tai-khoan>.workers.dev`. Thay URL Render tại ba nơi sau bằng URL này:
   - `index.html` (`API_URL`)
   - `glv-dashboard.html` (`API_URL`)
   - `apps-script-automation.gs` (`API_URL`)

`npm run test` chỉ bundle kiểm tra, không triển khai hay thay đổi Cloudflare.

Lưu ý: Workers không ngủ. Cache trong tiến trình chỉ là tối ưu ngắn hạn; API vẫn luôn đọc lại Google Sheets khi cache hết hạn.
