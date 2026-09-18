"""Create a GitHub release with UTF-8 notes and upload win-x64 zip asset."""
import json
import os
import sys
import urllib.request

REPO = "TristonLeiCheng/DanceMonkey"


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: create-github-release.py <tag> [notes.md] [zip-path]", file=sys.stderr)
        return 1

    tag = sys.argv[1].strip()
    if not tag.startswith("v"):
        tag = "v" + tag

    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    version = tag.lstrip("vV")
    notes_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, "docs", "releases", f"v{version}.md")
    zip_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(root, "publish", "win-x64", "artifacts", f"DanceMonkey-win-x64-{version}.zip")

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("GITHUB_TOKEN is required", file=sys.stderr)
        return 1

    with open(notes_path, "r", encoding="utf-8") as f:
        body = f.read()

    if not os.path.isfile(zip_path):
        print(f"Zip not found: {zip_path}", file=sys.stderr)
        return 1

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    payload = json.dumps({
        "tag_name": tag,
        "name": f"DanceMonkey {tag}",
        "body": body,
        "draft": False,
        "prerelease": False,
    }, ensure_ascii=False).encode("utf-8")

    create_headers = {**headers, "Content-Type": "application/json; charset=utf-8"}
    create_req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/releases",
        data=payload,
        headers=create_headers,
        method="POST",
    )
    with urllib.request.urlopen(create_req) as resp:
        rel = json.load(resp)

    upload_url = rel["upload_url"].split("{")[0]
    asset_name = os.path.basename(zip_path)
    with open(zip_path, "rb") as f:
        zip_bytes = f.read()

    upload_req = urllib.request.Request(
        f"{upload_url}?name={asset_name}",
        data=zip_bytes,
        headers={**headers, "Content-Type": "application/zip"},
        method="POST",
    )
    with urllib.request.urlopen(upload_req):
        pass

    print(rel["html_url"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
