#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import configparser
import json
import os
import sys
from pathlib import Path

import requests

TOKEN_URL = "https://ontocloak.apps.health.belgium.be/auth/realms/Terminology/protocol/openid-connect/token"

# Base64-encoded client credentials from your message
CLIENT_ID_B64 = "dGVybWlub2xvZ3ktc2VydmVy"
CLIENT_SECRET_B64 = "WGhEQ0pHaUNSeTF3Q2p2dUlmeWU2WFluSlNlbWhsREQ="


def b64_decode_str(s: str) -> str:
    s = s.strip()
    s += "=" * (-len(s) % 4)
    return base64.b64decode(s).decode("utf-8")


def build_basic_auth(client_id: str, client_secret: str) -> str:
    pair = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(pair).decode("ascii")


def read_creds_file(path: Path) -> tuple[str | None, str | None]:
    """
    Reads an INI file like:
      [terminology]
      username = you@example.org
      password = yourPassword
    """
    cfg = configparser.ConfigParser()
    cfg.read(path, encoding="utf-8")
    if "terminology" not in cfg:
        return None, None
    u = cfg["terminology"].get("username")
    p = cfg["terminology"].get("password")
    return u, p


def request_token(username: str, password: str, timeout: int = 30) -> dict:
    client_id = b64_decode_str(CLIENT_ID_B64)
    client_secret = b64_decode_str(CLIENT_SECRET_B64)

    headers = {
        "Authorization": build_basic_auth(client_id, client_secret),
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    }
    data = {
        "grant_type": "password",
        "username": username,
        "password": password,
    }

    r = requests.post(TOKEN_URL, headers=headers, data=data, timeout=timeout)

    if r.status_code != 200:
        # Prefer JSON error if present
        try:
            err = r.json()
            pretty = json.dumps(err, indent=2)
        except Exception:
            pretty = r.text

        raise RuntimeError(
            f"Token request failed (HTTP {r.status_code}).\n"
            f"Response:\n{pretty}\n"
        )

    return r.json()


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch Ontocloak access token and write it to a file.")
    ap.add_argument("--username", help="Username (overrides file/env if provided)")
    ap.add_argument("--password", help="Password (overrides file/env if provided)")
    ap.add_argument("--creds-file", default="termserver.ini", help="INI credentials file (default: termserver.ini)")
    ap.add_argument("--out", default="token.txt", help="Output token file (default: token.txt)")
    ap.add_argument("--timeout", type=int, default=30, help="HTTP timeout seconds (default: 30)")
    ap.add_argument("--print-token", action="store_true", help="Also print the access_token to stdout")
    args = ap.parse_args()

    username = args.username
    password = args.password

    # If not provided on CLI, try creds file
    if (not username) or (not password):
        creds_path = Path(args.creds_file)
        if creds_path.exists():
            fu, fp = read_creds_file(creds_path)
            username = username or fu
            password = password or fp

    # If still missing, try environment
    username = username or os.getenv("TERM_USERNAME")
    password = password or os.getenv("TERM_PASSWORD")

    if not username or not password:
        print(
            "Missing credentials.\n"
            "Provide --username/--password, or create termserver.ini, or set TERM_USERNAME/TERM_PASSWORD.\n\n"
            "Example termserver.ini:\n"
            "[terminology]\n"
            "username = you@example.org\n"
            "password = yourPassword\n",
            file=sys.stderr,
        )
        return 2

    token_response = request_token(username, password, timeout=args.timeout)
    access_token = token_response.get("access_token")
    if not access_token:
        print("No access_token in response.", file=sys.stderr)
        return 3

    out_path = Path(args.out)
    with open(out_path, "w", encoding="utf-8", newline="") as f:
      f.write(access_token.strip())
    with open(".env", "w", encoding="utf-8", newline="") as f:
        f.write(f"TOKEN={access_token.strip()}")      

    print(f"Wrote access token to: {out_path}")
    if "expires_in" in token_response:
        print(f"expires_in: {token_response['expires_in']} seconds")
    if args.print_token:
        print(access_token)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
