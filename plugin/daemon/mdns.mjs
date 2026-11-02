#!/usr/bin/env node
// Finds BUSY Bars on the local networks over mDNS, with nothing but Node built-ins (macOS and Windows alike).
//
//   node daemon/mdns.mjs [timeoutMs]      prints the bars found as JSON
//
// A bar announces `busybar-<usb mac>._http._tcp.local` on port 80 with TXT `path=/` and `name=<device name>`
// (firmware: services/discovery + web_server, lwIP's mdns responder).
//
// Transport: one socket per IPv4 interface, bound to that interface's address on an ephemeral port, sending a
// "legacy unicast" query (RFC 6762 §6.7) to 224.0.0.251:5353. Port 5353 itself belongs to mDNSResponder on macOS
// and often to the DNS Client service on Windows, so we never bind it. Any responder that sees a query from a port
// other than 5353 answers unicast to that address and port, which lwIP does unconditionally (mdns_init_outpacket),
// and the QU bit asks the same of responders that look only at it. Windows Firewall lets unicast replies to a
// multicast query through by default, so nothing needs installing or allowing.
// No dependencies; Node 20+.

import { randomInt } from "node:crypto";
import dgram from "node:dgram";
import os from "node:os";
import { fileURLToPath } from "node:url";

const MDNS_GROUP = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE = "_http._tcp.local";
const PREFIX = "busybar-";
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 };
/** Multicast is lossy and Wi-Fi drops it often: ask again at these points of the timeout. */
const RESEND_AT = [0.3, 0.6];

/** Finds BUSY Bars on the local networks. Resolves after timeoutMs with every bar that answered. */
export async function findBars({ timeoutMs = 3000 } = {}) {
  const seen = { instances: new Map(), sources: new Map(), srv: new Map(), txt: new Map(), a: new Map() };
  const sockets = interfaceAddresses().map((address) => {
    const socket = dgram.createSocket({ type: "udp4" });
    socket.on("error", () => {}); // an interface that went away (VPN, sleep): the others still count
    socket.on("message", (msg, rinfo) => {
      try {
        collect(parse(msg), rinfo.address, seen);
      } catch {
        // Not a DNS answer we can read; somebody else's business.
      }
    });
    socket.bind({ address, port: 0 }, () => {
      try {
        socket.setMulticastInterface(address);
        socket.setMulticastTTL(255);
      } catch {}
    });
    return socket;
  });
  // Calls on a socket that failed to bind or was closed throw synchronously; any of them only costs one try.
  const each = (fn) => sockets.forEach((socket) => {
    try {
      fn(socket);
    } catch {}
  });
  const send = () => each((socket) => socket.send(query(), MDNS_PORT, MDNS_GROUP, () => {}));
  const timers = [0, ...RESEND_AT].map((at) => setTimeout(send, at * timeoutMs)); // sends wait for the bind
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  timers.forEach(clearTimeout);
  each((socket) => socket.close());
  return [...seen.instances].map(([instance, source]) => {
    const srv = seen.srv.get(instance);
    const addressFrom = (from) => (srv && seen.a.get(`${from} ${srv.host}`)) || from;
    return {
      id: instance.split(".")[0],
      name: seen.txt.get(instance) ?? "",
      address: addressFrom(source),
      // Every network the bar answered on (USB and Wi-Fi): the daemon checks a new caller against all of them.
      addresses: [...new Set([...seen.sources.get(instance)].map(addressFrom))],
      port: srv?.port ?? 80,
    };
  });
}

function interfaceAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && (i.family === "IPv4" || i.family === 4) && !i.internal)
    .map((i) => i.address);
}

/** One PTR question for _http._tcp.local, class IN with the QU bit, a fresh id per send (legacy replies echo it). */
function query() {
  const labels = SERVICE.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(randomInt(0x10000), 0);
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(TYPE.PTR, 1);
  tail.writeUInt16BE(0x8001, 3);
  return Buffer.concat([header, ...labels, tail]);
}

/** Every resource record of a DNS response (answers, authority, additional). Throws on a truncated packet. */
function parse(msg) {
  if (msg.length < 12 || !(msg[2] & 0x80)) return [];
  let offset = 12;
  for (let q = msg.readUInt16BE(4); q > 0; q--) offset = readName(msg, offset).end + 4;
  const count = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  const records = [];
  for (let r = 0; r < count; r++) {
    const { name, end } = readName(msg, offset);
    const type = msg.readUInt16BE(end);
    const length = msg.readUInt16BE(end + 8);
    const start = end + 10;
    if (start + length > msg.length) throw new Error("truncated");
    records.push({ name, type, start, length });
    offset = start + length;
  }
  return records.map((r) => ({ ...r, data: rdata(msg, r) }));
}

function rdata(msg, { type, start, length }) {
  if (type === TYPE.A && length === 4) return [...msg.subarray(start, start + 4)].join(".");
  if (type === TYPE.PTR) return readName(msg, start).name;
  if (type === TYPE.SRV) return { port: msg.readUInt16BE(start + 4), host: readName(msg, start + 6).name };
  if (type === TYPE.TXT) {
    const strings = [];
    for (let i = start; i < start + length; i += 1 + msg[i]) strings.push(msg.toString("utf8", i + 1, i + 1 + msg[i]));
    return strings;
  }
  return null;
}

/** A (possibly compressed) name at offset, lowercased; `end` is where the record continues. */
function readName(msg, offset) {
  const labels = [];
  let end = -1;
  for (let jumps = 0; jumps < 64; jumps++) {
    const length = msg[offset];
    if (length === undefined) throw new Error("truncated");
    if (length === 0) return { name: labels.join(".").toLowerCase(), end: end < 0 ? offset + 1 : end };
    if ((length & 0xc0) === 0xc0) {
      if (end < 0) end = offset + 2;
      offset = msg.readUInt16BE(offset) & 0x3fff;
    } else {
      labels.push(msg.toString("utf8", offset + 1, offset + 1 + length));
      offset += 1 + length;
    }
  }
  throw new Error("name loop");
}

/**
 * Records may arrive spread over packets, so they are kept by name and joined at the end. A records are kept per
 * sender: a bar answers on USB and Wi-Fi under one host name ("bb.local"), and bars named alike share it too.
 * A bar heard on several networks keeps the first answer, unless that was a link-local one.
 */
function collect(records, source, seen) {
  const isBar = (name) => name.startsWith(PREFIX) && name.endsWith("." + SERVICE);
  const linkLocal = (address) => address?.startsWith("169.254.");
  for (const { name, type, data } of records) {
    if (data === null) continue;
    if (type === TYPE.PTR && name === SERVICE && isBar(data)) {
      seen.sources.set(data, new Set([...(seen.sources.get(data) ?? []), source]));
      const known = seen.instances.get(data);
      if (!known || (linkLocal(known) && !linkLocal(source))) seen.instances.set(data, source);
    }
    if (type === TYPE.SRV && isBar(name)) seen.srv.set(name, data);
    if (type === TYPE.TXT && isBar(name)) {
      const entry = data.find((s) => s.toLowerCase().startsWith("name="));
      if (entry) seen.txt.set(name, entry.slice(5));
    }
    if (type === TYPE.A) seen.a.set(`${source} ${name}`, data);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const timeoutMs = Number(process.argv[2]) || 3000;
  console.log(JSON.stringify(await findBars({ timeoutMs }), null, 2));
}
