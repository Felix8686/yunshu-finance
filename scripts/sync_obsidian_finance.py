import os
import sys
import json
import re
import hashlib
import argparse
import subprocess
import urllib.request
import urllib.parse
from datetime import datetime

VAULT_NOTE_PATH = r"D:\Obsidian\万象\00-导航\05-日常记账.md"
SYNC_STATE_PATH = r"D:\Obsidian\万象\Hermes维护\.finance_sync_state.json"
WANXIANG_REPO = r"D:\wanxiang-cloud"

def normalize_text(text: str) -> str:
    if not text:
        return ""
    return re.sub(r'[\s\(\)（）:：·,，\-_]', '', text).lower()

def compute_row_signature(date_str: str, amount_str: str) -> str:
    try:
        amt = f"{float(amount_str):.2f}"
    except Exception:
        amt = amount_str.strip()
    return f"{date_str.strip()}|{amt}"

def load_sync_state() -> dict:
    if os.path.exists(SYNC_STATE_PATH):
        try:
            with open(SYNC_STATE_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "version": 1,
        "last_sync_time": None,
        "synced_ids": []
    }

def save_sync_state(state: dict):
    os.makedirs(os.path.dirname(SYNC_STATE_PATH), exist_ok=True)
    tmp_path = SYNC_STATE_PATH + ".tmp"
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, SYNC_STATE_PATH)

def fetch_transactions_via_api(base_url: str, token: str, month_str: str) -> list:
    url = f"{base_url.rstrip('/')}/api/finance/transactions?month={month_str}&limit=200"
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "ObsidianFinanceSync/1.0"
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status}: {resp.read().decode('utf-8')}")
        body = json.loads(resp.read().decode('utf-8'))
        if not body.get("ok"):
            raise RuntimeError(f"API returned error: {body.get('error')}")
        return body.get("data", {}).get("items", [])

def query_d1_transactions(wanxiang_dir: str) -> list:
    cmd = [
        "npx.cmd" if sys.platform == "win32" else "npx",
        "wrangler", "d1", "execute", "wanxiang-cloud-dev",
        "--remote",
        "--command",
        "SELECT id, type, amount_fen, occurred_at, merchant, description, category_id, account_id, created_at, updated_at "
        "FROM transactions WHERE strftime('%Y-%m', occurred_at) >= '2026-09' ORDER BY occurred_at, id;",
        "--json"
    ]
    res = subprocess.run(cmd, cwd=wanxiang_dir, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"D1 query failed: {res.stderr or res.stdout}")
    
    stdout = res.stdout
    idx = stdout.find('[')
    if idx == -1:
        raise RuntimeError(f"Unexpected D1 output: {stdout}")
    data = json.loads(stdout[idx:])
    return data[0].get("results", [])

CATEGORY_MAP = {
    'cat-expense-food': '餐饮',
    'restored-cat-expense-59a3bdb54b997f72': '食材',
    'restored-cat-expense-bd77bb90a42df39c': '烟酒',
    'restored-cat-expense-ba6c890e22fba2fd': '日用',
    'restored-cat-expense-09d98a4e4bcc3280': '其它',
    'restored-cat-expense-30c1157d6b38c267': '医疗',
    'restored-cat-expense-77d6928e469d4e5f': '数码',
    'restored-cat-expense-5a557bfa37311ee8': '住房',
    'restored-cat-expense-732381286c125d0c': '服饰',
    'restored-cat-expense-8547847ea63c4eb3': '交通',
    'restored-cat-expense-b430c6a815a5fbf2': '娱乐',
}

def format_row(tx: dict) -> tuple:
    dt = tx['occurred_at']
    date_md = dt[5:10]
    amount = f"{(tx['amount_fen'] / 100.0):.2f}"
    
    cat_id = tx.get('category_id') or ''
    category_name = tx.get('category_name') or CATEGORY_MAP.get(cat_id, '其它')
    
    acc_id = tx.get('account_id') or ''
    account_name = tx.get('account_name')
    if not account_name:
        if 'alipay' in acc_id.lower() or acc_id == '59a175ad-4546-4b14-ae23-d3090c04e345':
            account_name = '支付宝'
        elif 'wechat' in acc_id.lower():
            account_name = '微信'
        else:
            account_name = '其他扫码付'
    
    merchant = tx.get('merchant')
    desc = tx.get('description') or ''
    if merchant and merchant not in desc and not desc.startswith('购物小票'):
        item_text = f"{merchant}：{desc}"
    else:
        item_text = desc
    
    note = ""
    tx_type = tx.get('type', 'expense')
    expense_str = amount if tx_type == 'expense' else ""
    income_str = amount if tx_type == 'income' else ""
    
    md_line = f"| {date_md} | {item_text} | {category_name} | {expense_str:>5} | {income_str:>4} | {account_name} | {note} |"
    sig = compute_row_signature(date_md, amount)
    norm_desc = normalize_text(item_text)
    return date_md, md_line, sig, norm_desc

def run_sync(dry_run: bool = True, base_url: str = None, token: str = None):
    print(f"[*] Starting Obsidian Finance Sync (dry_run={dry_run})...")
    
    if not os.path.exists(VAULT_NOTE_PATH):
        raise FileNotFoundError(f"Vault note not found: {VAULT_NOTE_PATH}")
    
    with open(VAULT_NOTE_PATH, 'r', encoding='utf-8') as f:
        content = f.read()
    
    state = load_sync_state()
    synced_ids = set(state.get("synced_ids", []))
    
    lines = content.split('\n')
    existing_rows = []
    for l in lines:
        if l.startswith('|') and not l.startswith('|---') and '日期' not in l:
            parts = [p.strip() for p in l.split('|')[1:-1]]
            if len(parts) >= 6:
                date_str = parts[0]
                desc_str = parts[1]
                exp_str = parts[3]
                inc_str = parts[4]
                amt_str = exp_str if exp_str else inc_str
                sig = compute_row_signature(date_str, amt_str)
                norm_desc = normalize_text(desc_str)
                existing_rows.append((sig, norm_desc, l))
    
    print(f"[*] Indexed {len(existing_rows)} existing local rows.")
    
    if base_url and token:
        print(f"[*] Fetching transactions via Cloud API: {base_url}")
        current_month = datetime.now().strftime("%Y-%m")
        transactions = fetch_transactions_via_api(base_url, token, current_month)
    else:
        print(f"[*] Fetching transactions via local Cloudflare CLI from D1...")
        transactions = query_d1_transactions(WANXIANG_REPO)
        
    print(f"[*] Fetched {len(transactions)} transactions from Cloud.")
    
    pending_to_insert = []
    matched_count = 0
    
    for tx in transactions:
        tx_id = tx['id']
        date_md, md_line, sig, norm_desc = format_row(tx)
        
        if tx_id in synced_ids:
            continue
            
        found_match = False
        for ex_sig, ex_desc, ex_line in existing_rows:
            if ex_sig == sig:
                if not norm_desc or not ex_desc:
                    found_match = True
                    break
                if norm_desc in ex_desc or ex_desc in norm_desc:
                    found_match = True
                    break
                common = set(norm_desc) & set(ex_desc)
                if len(common) >= 2 or len(common) / max(len(norm_desc), len(ex_desc)) > 0.4:
                    found_match = True
                    break
                    
        if found_match:
            matched_count += 1
            synced_ids.add(tx_id)
            continue
            
        pending_to_insert.append((tx_id, date_md, md_line, tx))
        
    print(f"[*] Analysis complete:")
    print(f"    - Existing matched/synced: {matched_count}")
    print(f"    - Pending new insertions: {len(pending_to_insert)}")
    
    if not pending_to_insert:
        print("[+] Everything is up to date. No new rows to insert.")
        if not dry_run and (len(synced_ids) != len(state.get("synced_ids", []))):
            state["synced_ids"] = list(synced_ids)
            state["last_sync_time"] = datetime.now().isoformat()
            save_sync_state(state)
            print("[+] Updated sync state ledger.")
        return
        
    for item in pending_to_insert:
        tx_id, date_md, line_text, raw = item
        amt = raw['amount_fen'] / 100.0
        desc = raw.get('description')
        print(f"    + [NEW] {date_md} | {amt:.2f}元 | {desc} (ID: {tx_id[:8]})")
        
    if dry_run:
        print("[!] Dry-run enabled. No changes written to Obsidian or state ledger.")
        return
        
    sep_section = "## 2026-09"
    next_section = "## 下个月怎么继续"
    
    if sep_section not in content or next_section not in content:
        raise RuntimeError("Could not find section boundaries in 05-日常记账.md")
        
    before_sep, rest = content.split(sep_section, 1)
    sep_body, after_sep = rest.split(next_section, 1)
    
    sep_lines = [l for l in sep_body.strip().split('\n') if l.strip()]
    table_lines = [l for l in sep_lines if l.startswith('|')]
    
    new_rows = [item[2] for item in pending_to_insert]
    
    combined_rows = []
    header_lines = []
    for l in table_lines:
        if l.startswith('|---') or '日期' in l:
            header_lines.append(l)
        else:
            combined_rows.append(l)
            
    combined_rows.extend(new_rows)
    
    def extract_row_sort_key(row_str):
        parts = [p.strip() for p in row_str.split('|')[1:-1]]
        return parts[0] if parts else "99-99"
        
    combined_rows.sort(key=extract_row_sort_key)
    
    new_sep_body = "\n\n" + "\n".join(header_lines + combined_rows) + "\n\n"
    new_content = before_sep + sep_section + new_sep_body + next_section + after_sep
    
    tmp_vault_path = VAULT_NOTE_PATH + ".tmp"
    with open(tmp_vault_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    os.replace(tmp_vault_path, VAULT_NOTE_PATH)
    print(f"[+] Successfully wrote {len(new_rows)} rows to {VAULT_NOTE_PATH} via atomic rename.")
    
    for tx_id, _, _, _ in pending_to_insert:
        synced_ids.add(tx_id)
        
    state["synced_ids"] = list(synced_ids)
    state["last_sync_time"] = datetime.now().isoformat()
    save_sync_state(state)
    print(f"[+] Successfully updated {SYNC_STATE_PATH}.")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Obsidian Finance Sync Engine")
    parser.add_argument("--dry-run", action="store_true", default=False, help="Run in dry-run mode without writing")
    parser.add_argument("--apply", action="store_true", default=False, help="Apply changes to Obsidian note and sync state")
    parser.add_argument("--api-url", type=str, default=None, help="Cloud Worker API URL")
    parser.add_argument("--token", type=str, default=None, help="Bearer token for Cloud Worker API")
    args = parser.parse_args()
    
    is_dry_run = not args.apply
    run_sync(dry_run=is_dry_run, base_url=args.api_url, token=args.token)
