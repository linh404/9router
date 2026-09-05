# Huong dan su dung 9router ChatGPT/Codex Bulk Importer

File nay huong dan cach chay tool import token ChatGPT/Codex vao 9router bang CLI hoac GUI.

## Yeu cau

- Windows.
- Node.js 18 tro len. Neu ban da cai 9router thi thuong Node da co san trong moi truong chay.
- 9router da duoc cai va da chay it nhat mot lan de tao thu muc du lieu.
- File token dang `.json`, `.zip` chua `.json`, hoac mot thu muc chua cac file do.

## Chay nhanh bang file CMD

1. Dat file token vao thu muc `tokens`.
2. Tat 9router neu ban khong muon tool tu dong tat/mo lai.
3. Nhap doi `import.cmd`.
4. Sau khi xong, mo dashboard 9router va kiem tra muc `Providers -> Codex/ChatGPT`.

Neu 9router dang chay, cach an toan hon la dung GUI va giu tuy chon `Tu dong dung & khoi dong lai 9router`.

## Dung GUI

1. Nhap doi `gui.cmd`.
2. Trinh duyet se mo giao dien cuc bo tai `127.0.0.1`.
3. Keo tha file `.json`, `.zip`, hoac ca thu muc vao o chon file.
4. Bam `Kiem tra token` de xem truoc danh sach doc duoc.
5. Bam `Import vao 9router` de ghi vao database.

GUI gioi han payload khoang 32 MiB. Neu file ZIP lon, hay dung CLI.

## Dung CLI

Mo PowerShell tai thu muc project va chay:

```powershell
node .\import.js --list
```

Lenh tren chi kiem tra file trong `tokens` va khong ghi database.

Import file trong `tokens` va tu dong dung/khoi dong lai 9router:

```powershell
node .\import.js .\tokens --force-stop
```

Import mot file cu the:

```powershell
node .\import.js "D:\tokens\account.json" --force-stop
```

Import mot file ZIP:

```powershell
node .\import.js "D:\tokens\accounts.zip" --force-stop
```

Chi dinh database rieng:

```powershell
node .\import.js .\tokens --db "D:\tmp\db.json" --no-restart
```

## Cac tuy chon hay dung

| Tuy chon | Y nghia |
| --- | --- |
| `--list`, `--dry`, `--dry-run` | Chi doc va hien thi preview, khong ghi DB. |
| `--force-stop` | Neu 9router dang chay, tool se dung 9router, ghi DB, roi khoi dong lai. |
| `--no-restart` | Ghi DB nhung khong khoi dong lai 9router. Chi dung khi 9router da tat. |
| `--no-configure-codex` | Khong ghi `~/.codex/config.toml` va `~/.codex/auth.json`. |
| `--db <path>` | Chi dinh duong dan `data.sqlite` hoac `db.json`. |
| `--url <baseUrl>` | Chi dinh URL 9router, mac dinh `http://127.0.0.1:20128`. |

## Dinh dang token dau vao

Tool chap nhan:

- JSON don co `id_token`, `access_token`, `refresh_token`.
- JSON mang, tool lay object hop le dau tien.
- JSON wrapper co `accounts`.
- JSON wrapper co `tokens`.
- File `.zip` chua nhieu file `.json`.
- Thu muc chua nhieu `.json` hoac `.zip`.

Vi du:

```json
{
  "id_token": "eyJ...",
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "account_id": "00000000-0000-0000-0000-000000000000",
  "email": "you@example.com",
  "expired": "2026-06-01T20:53:27Z"
}
```

## Luu y an toan

- Khong commit token that len Git. `.gitignore` da bo qua `tokens/*.json` va `tokens/*.zip`.
- Tool tao backup database truoc khi ghi, vi du `data.sqlite.bak-<timestamp>`.
- Tool khong in day du access token hoac refresh token ra console.
- Neu 9router dang chay ma khong dung `--force-stop`, CLI se tu choi ghi de tranh mat du lieu.

## Xu ly loi nhanh

- `Khong co file dau vao hop le`: hay dat file `.json`/`.zip` vao `tokens` hoac truyen duong dan file vao CLI.
- `9router dang chay`: them `--force-stop` hoac tat 9router thu cong.
- `ZIP qua lon cho GUI`: chay bang CLI.
- `Khong tai duoc better-sqlite3`: mo 9router mot lan de dam bao runtime cua 9router duoc cai day du, hoac dung duong dan `db.json` neu ban dang dung ban cu.
