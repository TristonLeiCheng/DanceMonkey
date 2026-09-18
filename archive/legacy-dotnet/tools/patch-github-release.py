import json
import os
import urllib.request

token = os.environ["GITHUB_TOKEN"]
notes_path = os.path.join(os.path.dirname(__file__), "..", "docs", "releases", "v1.3.0.md")
with open(notes_path, "r", encoding="utf-8") as f:
    body = f.read()

headers = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json; charset=utf-8",
}

req = urllib.request.Request(
    "https://api.github.com/repos/TristonLeiCheng/DanceMonkey/releases/tags/v1.3.0",
    headers=headers,
)
with urllib.request.urlopen(req) as resp:
    rel = json.load(resp)

payload = json.dumps({"body": body}, ensure_ascii=False).encode("utf-8")
patch = urllib.request.Request(
    f"https://api.github.com/repos/TristonLeiCheng/DanceMonkey/releases/{rel['id']}",
    data=payload,
    headers=headers,
    method="PATCH",
)
with urllib.request.urlopen(patch) as resp:
    updated = json.load(resp)

print(updated["html_url"])
print(updated["body"][:100])
