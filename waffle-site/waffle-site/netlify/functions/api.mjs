import { getStore } from "@netlify/blobs";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { DEFAULT_CONTENT } from "./defaults.mjs";

export const config = { path: "/api/*" };

const db = () => getStore("waffle");
const json = (d, s = 200) => Response.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const str = (v, n) => String(v ?? "").trim().slice(0, n);
const sha = (s) => createHash("sha256").update(String(s)).digest();
const sign = (s) => createHmac("sha256", process.env.SESSION_SECRET || "").update(s).digest("hex");

function authed(req) {
  const t = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const [exp, sig] = t.split(".");
  if (!process.env.SESSION_SECRET || !exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanContent(c = {}) {
  return {
    menu: (c.menu || []).slice(0, 10).map((k) => ({
      title: str(k.title, 60),
      items: (k.items || []).slice(0, 40).map((i) => ({ name: str(i.name, 80), desc: str(i.desc, 160), price: str(i.price, 20) })),
    })),
    contact: {
      address: str(c.contact?.address, 200),
      hours: (c.contact?.hours || []).slice(0, 10).map((h) => ({ label: str(h.label, 40), time: str(h.time, 40) })),
      phone: str(c.contact?.phone, 30),
      whatsapp: str(c.contact?.whatsapp, 30),
      map: str(c.contact?.map, 1500),
      email: str(c.contact?.email, 80),
      instagram: str(c.contact?.instagram, 40),
    },
    gallery: (c.gallery || []).slice(0, 24).map((g) => ({ id: str(g.id, 40).replace(/[^\w-]/g, ""), caption: str(g.caption, 60) })),
  };
}

export default async (req) => {
  try {
    const s = db();
    const parts = new URL(req.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const m = req.method;
    const body = async () => req.json().catch(() => ({}));
    const getContent = async () => (await s.get("content", { type: "json" })) || DEFAULT_CONTENT;
    const getComments = async () => (await s.get("comments", { type: "json" })) || [];

    // ---- herkese açık ----
    if (parts[0] === "content" && m === "GET") {
      const approved = (await getComments()).filter((c) => c.status === "approved")
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50)
        .map(({ name, rating, text, date }) => ({ name, rating, text, date }));
      return json({ ...(await getContent()), comments: approved });
    }

    if (parts[0] === "comments" && m === "POST") {
      const b = await body();
      if (b.website) return json({ ok: true }); // bot tuzağı
      const name = str(b.name, 40), text = str(b.text, 600), rating = Math.round(Number(b.rating));
      if (name.length < 2) return json({ error: "Lütfen adını yaz." }, 400);
      if (text.length < 5) return json({ error: "Yorum çok kısa." }, 400);
      if (!(rating >= 1 && rating <= 5)) return json({ error: "Lütfen puan seç." }, 400);
      const all = await getComments();
      if (all.filter((c) => c.status === "pending").length >= 200) return json({ error: "Şu an yorum alamıyoruz." }, 429);
      all.push({ id: randomUUID(), name, rating, text, status: "pending", date: new Date().toISOString() });
      await s.setJSON("comments", all);
      return json({ ok: true }, 201);
    }

    if (parts[0] === "img" && parts[1] && m === "GET") {
      const r = await s.getWithMetadata("img:" + parts[1].replace(/[^\w-]/g, ""), { type: "arrayBuffer" });
      if (!r) return new Response("Not found", { status: 404 });
      return new Response(r.data, { headers: { "Content-Type": r.metadata?.type || "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
    }

    if (parts[0] === "login" && m === "POST") {
      const { password } = await body();
      const real = process.env.ADMIN_PASSWORD;
      const ok = !!real && !!process.env.SESSION_SECRET && timingSafeEqual(sha(password ?? ""), sha(real));
      if (!ok) { await new Promise((r) => setTimeout(r, 1000)); return json({ error: "Şifre yanlış." }, 401); }
      const exp = Date.now() + 7 * 864e5;
      return json({ token: exp + "." + sign(String(exp)) });
    }

    // ---- yönetici ----
    if (parts[0] === "admin") {
      if (!authed(req)) return json({ error: "Yetkisiz" }, 401);

      if (parts[1] === "data" && m === "GET")
        return json({ content: await getContent(), comments: (await getComments()).sort((a, b) => b.date.localeCompare(a.date)) });

      if (parts[1] === "content" && m === "PUT") {
        await s.setJSON("content", cleanContent(await body()));
        return json({ ok: true });
      }

      if (parts[1] === "comments" && parts[2]) {
        const all = await getComments();
        const i = all.findIndex((c) => c.id === parts[2]);
        if (i < 0) return json({ error: "Bulunamadı" }, 404);
        if (m === "PATCH") { const { status } = await body(); if (!["approved", "pending"].includes(status)) return json({ error: "Geçersiz" }, 400); all[i].status = status; }
        else if (m === "DELETE") all.splice(i, 1);
        else return json({ error: "Geçersiz" }, 405);
        await s.setJSON("comments", all);
        return json({ ok: true });
      }

      if (parts[1] === "images" && m === "POST") {
        const { dataUrl } = await body();
        const mt = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl || "");
        if (!mt) return json({ error: "Geçersiz resim" }, 400);
        const buf = Buffer.from(mt[2], "base64");
        if (buf.length > 2_000_000) return json({ error: "Resim çok büyük" }, 413);
        const id = randomUUID().slice(0, 12);
        await s.set("img:" + id, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), { metadata: { type: "image/" + mt[1] } });
        return json({ id }, 201);
      }

      if (parts[1] === "images" && parts[2] && m === "DELETE") {
        await s.delete("img:" + parts[2].replace(/[^\w-]/g, ""));
        return json({ ok: true });
      }
    }

    return json({ error: "Bulunamadı" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Sunucu hatası" }, 500);
  }
};
