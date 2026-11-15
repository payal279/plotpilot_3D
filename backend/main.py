import os
import re
import sqlite3
import time
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from planner import build_response

app = FastAPI(title="PlotPilot API")

# Dev only: restrict allow_origins to your real website address before deploying.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# For real use, set a long random secret:  set PLOTPILOT_SECRET=some-long-random-string
SECRET_KEY = os.getenv("PLOTPILOT_SECRET", "dev-only-change-me")
TOKEN_TTL = 60 * 60 * 24 * 7  # 7 days
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plotpilot.db")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_PROJECTS = 50
bearer = HTTPBearer(auto_error=False)

# Simple login throttle: 5 wrong passwords per email in 5 minutes (kept in memory).
FAILS = {}
FAIL_LIMIT, FAIL_WINDOW = 5, 300


# ---------- database ----------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash BLOB NOT NULL,
            created_at INTEGER NOT NULL
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )"""
    )
    conn.commit()
    conn.close()


init_db()


# ---------- models ----------
class SignupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    email: str = Field(max_length=254)
    password: str = Field(min_length=8, max_length=72)


class LoginIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=72)


class PromptIn(BaseModel):
    prompt: str = Field(max_length=500)


class ProjectIn(BaseModel):
    title: str = Field(default="", max_length=80)
    prompt: str = Field(min_length=1, max_length=500)


# ---------- helpers ----------
def make_token(user_id: int) -> str:
    payload = {"sub": str(user_id), "exp": int(time.time()) + TOKEN_TTL}
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)):
    if creds is None:
        raise HTTPException(status_code=401, detail="Not logged in")
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=["HS256"])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Session expired, please log in again")
    conn = get_db()
    row = conn.execute("SELECT id, name, email FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    if row is None:
        raise HTTPException(status_code=401, detail="Account not found")
    return {"id": row["id"], "name": row["name"], "email": row["email"]}


def too_many_fails(email: str) -> bool:
    now = time.time()
    FAILS[email] = [t for t in FAILS.get(email, []) if now - t < FAIL_WINDOW]
    return len(FAILS[email]) >= FAIL_LIMIT


# ---------- auth routes ----------
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/signup", status_code=201)
def signup(body: SignupIn):
    name = body.name.strip()
    email = body.email.strip().lower()
    pw = body.password.encode("utf-8")
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    if len(pw) > 72:
        raise HTTPException(status_code=400, detail="Password is too long")

    hashed = bcrypt.hashpw(pw, bcrypt.gensalt())
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
            (name, email, hashed, int(time.time())),
        )
        conn.commit()
        user_id = cur.lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="This email is already registered")
    finally:
        conn.close()

    return {"token": make_token(user_id), "user": {"id": user_id, "name": name, "email": email}}


@app.post("/api/login")
def login(body: LoginIn):
    email = body.email.strip().lower()
    pw = body.password.encode("utf-8")
    if too_many_fails(email):
        raise HTTPException(status_code=429, detail="Too many attempts. Please wait a few minutes and try again.")
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    if row is None or len(pw) > 72 or not bcrypt.checkpw(pw, row["password_hash"]):
        FAILS.setdefault(email, []).append(time.time())
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    FAILS.pop(email, None)
    user = {"id": row["id"], "name": row["name"], "email": row["email"]}
    return {"token": make_token(row["id"]), "user": user}


@app.get("/api/me")
def me(user=Depends(current_user)):
    return user


# ---------- design generation (login required) ----------
@app.post("/api/generate")
def generate(body: PromptIn, user=Depends(current_user)):
    text = body.prompt.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Please describe your house")
    try:
        return build_response(text)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------- saved designs ----------
@app.get("/api/projects")
def list_projects(user=Depends(current_user)):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, title, prompt, created_at FROM projects WHERE user_id = ? ORDER BY id DESC", (user["id"],)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/projects", status_code=201)
def save_project(body: ProjectIn, user=Depends(current_user)):
    prompt = body.prompt.strip()
    title = body.title.strip() or prompt[:60]
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) AS c FROM projects WHERE user_id = ?", (user["id"],)).fetchone()["c"]
    if count >= MAX_PROJECTS:
        conn.close()
        raise HTTPException(status_code=400, detail="Saved designs limit reached. Delete an old one first.")
    cur = conn.execute(
        "INSERT INTO projects (user_id, title, prompt, created_at) VALUES (?, ?, ?, ?)",
        (user["id"], title, prompt, int(time.time())),
    )
    conn.commit()
    pid = cur.lastrowid
    conn.close()
    return {"id": pid, "title": title, "prompt": prompt}


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int, user=Depends(current_user)):
    conn = get_db()
    cur = conn.execute("DELETE FROM projects WHERE id = ? AND user_id = ?", (project_id, user["id"]))
    conn.commit()
    deleted = cur.rowcount
    conn.close()
    if not deleted:
        raise HTTPException(status_code=404, detail="Design not found")
    return {"deleted": project_id}