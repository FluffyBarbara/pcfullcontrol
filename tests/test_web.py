import pytest
from fastapi.testclient import TestClient

from pcontrol.web.server import create_app


@pytest.fixture
def client(ctx):
    ctx.web_auth.set_password("testpass")
    return TestClient(create_app(ctx), client=("10.0.0.5", 5000))


def auth(client):
    r = client.post("/api/login", json={"password": "testpass"})
    assert r.status_code == 200
    return {"Authorization": "Bearer " + r.json()["token"]}


def test_index_and_static(client):
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert "Content-Security-Policy" in client.get("/").headers


def test_requires_auth(client):
    assert client.get("/api/status").status_code == 401
    assert client.get("/api/status", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/api/login", json={"password": "bad"}).status_code == 401


def test_info_status_metrics(client, ctx):
    h = auth(client)
    info = client.get("/api/info", headers=h).json()
    names = {a["name"] for a in info["actions"]}
    assert {"shutdown", "reboot", "check_updates", "set_volume"} <= names
    assert "shell" not in names  # выключено по умолчанию
    s = client.get("/api/status", headers=h).json()
    assert 0 <= s["cpu"]["percent"] <= 100 and s["ram"]["total"] > 0
    ctx.db.add_metrics(10, 20, 30, None, 1, 2)
    assert len(client.get("/api/metrics?hours=1", headers=h).json()) == 1


def test_action_and_log(client, ctx):
    h = auth(client)
    r = client.post("/api/action/notify", json={"arg": "тест"}, headers=h).json()
    assert r["ok"]
    cmds = client.get("/api/commands", headers=h).json()
    assert cmds[0]["action"] == "notify" and cmds[0]["source"] == "web"
    assert client.post("/api/action/nope", json={}, headers=h).status_code == 404


def test_processes(client):
    h = auth(client)
    procs = client.get("/api/processes?limit=5", headers=h).json()
    assert 0 < len(procs) <= 5 and "pid" in procs[0]


def test_tasks_crud(client):
    h = auth(client)
    r = client.post("/api/tasks", json={"action": "lock", "kind": "in", "delay_minutes": 10}, headers=h)
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    r = client.post("/api/tasks", json={"action": "shutdown", "kind": "daily", "time_of_day": "23:00",
                                        "weekdays": [0, 1, 2, 3, 4]}, headers=h)
    assert r.status_code == 200 and "будням" in r.json()["description"]
    r = client.post("/api/tasks", json={"action": "say", "kind": "in", "delay_minutes": 5}, headers=h)
    assert r.status_code == 400  # нужен параметр
    assert len(client.get("/api/tasks", headers=h).json()) == 2
    assert client.post(f"/api/tasks/{tid}/toggle", headers=h).json()["enabled"] is False
    assert client.delete(f"/api/tasks/{tid}", headers=h).status_code == 200


def test_files_upload_download_delete(client, ctx, tmp_path):
    h = auth(client)
    r = client.post("/api/files/upload", files={"file": ("hello.txt", b"hi there")}, headers=h)
    assert r.status_code == 200, r.text
    path = r.json()["path"]
    listing = client.get("/api/files", params={"path": str(ctx.config.upload_dir)}, headers=h).json()
    assert any(e["name"] == "hello.txt" for e in listing["entries"])
    assert client.get("/api/files/download", params={"path": path}, headers=h).content == b"hi there"
    assert client.post("/api/files/delete", json={"path": path}, headers=h).status_code == 200
    assert client.get("/api/files", headers=h).json()["entries"]  # корневые расположения


def test_password_change_and_sessions(client):
    h = auth(client)
    assert client.post("/api/password", json={"old": "bad", "new": "newpass1"}, headers=h).status_code == 400
    assert client.post("/api/password", json={"old": "testpass", "new": "newpass1"}, headers=h).status_code == 200
    assert client.get("/api/info", headers=h).status_code == 401  # сеансы сброшены
    assert client.post("/api/login", json={"password": "newpass1"}).status_code == 200


def test_app_launch_index(client):
    h = auth(client)
    assert client.post("/api/apps/99", headers=h).status_code == 404
