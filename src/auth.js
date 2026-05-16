import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Level } from "level";

const TREEHOLE_ORIGIN_KEY = "_https://treehole.pku.edu.cn";
const DEFAULT_UUID = "94B7DB0A74D347E7A6B29AE9569079AC";
const LOCAL_STORAGE_VALUE_PREFIX = "\x01";

function chromeBaseDir() {
  return (
    process.env.CHROME_USER_DATA_DIR ||
    path.join(os.homedir(), "Library/Application Support/Google/Chrome")
  );
}

function stripChromeValuePrefix(value) {
  const text = value.toString("utf8");
  return text.startsWith(LOCAL_STORAGE_VALUE_PREFIX) ? text.slice(1) : text;
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split(".");
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function authFromEnv() {
  if (!process.env.TREEHOLE_TOKEN) return null;
  const payload = decodeJwtPayload(process.env.TREEHOLE_TOKEN);
  return {
    token: process.env.TREEHOLE_TOKEN,
    uuid: process.env.TREEHOLE_UUID || DEFAULT_UUID,
    expiresAt: payload.exp || null,
    subject: payload.sub || null,
    source: "env:TREEHOLE_TOKEN",
  };
}

async function discoverProfileDirs() {
  const base = chromeBaseDir();
  const entries = await fs.readdir(base, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      leveldbDir: path.join(base, entry.name, "Local Storage", "leveldb"),
    }));
}

async function copyLevelDb(profile) {
  const safeName = profile.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const target = path.join(
    os.tmpdir(),
    `treehole-hot-rank-${process.pid}-${Date.now()}-${safeName}`,
  );
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(profile.leveldbDir, target, { recursive: true, force: true });
  return target;
}

async function readProfileLocalStorage(profile) {
  let tempDir;
  let db;
  const values = {};

  try {
    tempDir = await copyLevelDb(profile);
    db = new Level(tempDir, {
      keyEncoding: "buffer",
      valueEncoding: "buffer",
    });

    for await (const [key, value] of db.iterator()) {
      const keyText = key.toString("utf8");
      if (!keyText.startsWith(TREEHOLE_ORIGIN_KEY)) continue;

      if (keyText.endsWith("\x00\x01token")) {
        values.token = stripChromeValuePrefix(value);
      } else if (keyText.endsWith("\x00\x01pku-uuid")) {
        values.uuid = stripChromeValuePrefix(value);
      } else if (keyText.endsWith("\x00\x01expires_in")) {
        values.expiresIn = Number(stripChromeValuePrefix(value));
      }
    }
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        await db.close();
      } catch {}
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (!values.token) return null;
  const payload = decodeJwtPayload(values.token);
  return {
    token: values.token,
    uuid: values.uuid || DEFAULT_UUID,
    expiresAt: payload.exp || values.expiresIn || null,
    subject: payload.sub || null,
    source: `Chrome:${profile.name}`,
  };
}

function isUsableAuth(auth) {
  if (!auth?.token) return false;
  if (!auth.expiresAt) return true;
  const now = Math.floor(Date.now() / 1000);
  return Number(auth.expiresAt) > now + 60;
}

export async function resolveTreeholeAuth() {
  const envAuth = authFromEnv();
  if (isUsableAuth(envAuth)) return envAuth;

  const preferredProfile = process.env.TREEHOLE_CHROME_PROFILE;
  const profiles = await discoverProfileDirs();
  const orderedProfiles = preferredProfile
    ? [
        ...profiles.filter((profile) => profile.name === preferredProfile),
        ...profiles.filter((profile) => profile.name !== preferredProfile),
      ]
    : profiles;

  const candidates = [];
  for (const profile of orderedProfiles) {
    const auth = await readProfileLocalStorage(profile);
    if (auth) candidates.push(auth);
  }

  candidates.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
  const usable = candidates.find(isUsableAuth);
  if (!usable) {
    throw new Error(
      "没有在 Chrome localStorage 中找到有效的北大树洞登录态；请保持已登录，或设置 TREEHOLE_TOKEN。",
    );
  }

  return usable;
}

export function authPublicInfo(auth) {
  return {
    source: auth?.source || null,
    expiresAt: auth?.expiresAt || null,
    subject: auth?.subject || null,
  };
}
