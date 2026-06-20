"use client";

import { useEffect, useState } from "react";
import {
  fetchSettingsCustomers,
  fetchSettingsVendors,
  fetchSettingsVessels,
  createSettingsCustomer,
  createSettingsVendor,
  createSettingsVessel,
  fetchCustomers,
} from "@/lib/api";
import type {
  SettingsCustomer,
  SettingsVendor,
  SettingsVessel,
  CustomerOption,
} from "@/lib/types";
import AuthGate from "@/components/AuthGate";
import Nav from "@/components/Nav";

type Tab = "customers" | "vendors" | "vessels";

export default function SettingsPage() {
  return (
    <AuthGate>
      <Settings />
    </AuthGate>
  );
}

function Settings() {
  const [tab, setTab] = useState<Tab>("customers");
  return (
    <div className="page">
      <Nav active="settings" />
      <div className="seg-tabs">
        <button
          className={tab === "customers" ? "on" : ""}
          onClick={() => setTab("customers")}
        >
          고객
        </button>
        <button
          className={tab === "vendors" ? "on" : ""}
          onClick={() => setTab("vendors")}
        >
          벤더
        </button>
        <button
          className={tab === "vessels" ? "on" : ""}
          onClick={() => setTab("vessels")}
        >
          선박
        </button>
      </div>
      {tab === "customers" && <Customers />}
      {tab === "vendors" && <Vendors />}
      {tab === "vessels" && <Vessels />}
    </div>
  );
}

function useErr() {
  const [err, setErr] = useState<string | null>(null);
  return { err, setErr };
}

function Customers() {
  const [rows, setRows] = useState<SettingsCustomer[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const { err, setErr } = useErr();

  const load = () => fetchSettingsCustomers().then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
  }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await createSettingsCustomer({ name, email, contact });
      setName("");
      setEmail("");
      setContact("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="add-row">
        <input placeholder="고객명 *" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="담당자" value={contact} onChange={(e) => setContact(e.target.value)} />
        <input placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn primary" onClick={add} disabled={busy || !name.trim()}>
          {busy ? "추가 중…" : "추가"}
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
      <table className="mini wide">
        <thead>
          <tr>
            <th>고객명</th>
            <th>담당자</th>
            <th>이메일</th>
            <th>국가</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.contact || "—"}</td>
              <td>{r.email || "—"}</td>
              <td>{r.country || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Vendors() {
  const [rows, setRows] = useState<SettingsVendor[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const { err, setErr } = useErr();

  const load = () => fetchSettingsVendors().then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
  }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await createSettingsVendor({ name, email, specialization: spec });
      setName("");
      setEmail("");
      setSpec("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="add-row">
        <input placeholder="벤더명 *" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="전문분야" value={spec} onChange={(e) => setSpec(e.target.value)} />
        <button className="btn primary" onClick={add} disabled={busy || !name.trim()}>
          {busy ? "추가 중…" : "추가"}
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
      <table className="mini wide">
        <thead>
          <tr>
            <th>벤더명</th>
            <th>이메일</th>
            <th>전문분야</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.email || "—"}</td>
              <td>{r.specialization || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Vessels() {
  const [rows, setRows] = useState<SettingsVessel[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [name, setName] = useState("");
  const [imo, setImo] = useState("");
  const [customerId, setCustomerId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const { err, setErr } = useErr();

  const load = () => fetchSettingsVessels().then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
    fetchCustomers().then(setCustomers).catch(() => setCustomers([]));
  }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await createSettingsVessel({
        name,
        imo,
        customer_id: customerId === "" ? undefined : customerId,
      });
      setName("");
      setImo("");
      setCustomerId("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="add-row">
        <input placeholder="선박명 *" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="IMO" value={imo} onChange={(e) => setImo(e.target.value)} />
        <select
          value={customerId}
          onChange={(e) =>
            setCustomerId(e.target.value === "" ? "" : Number(e.target.value))
          }
        >
          <option value="">소속 고객(선택)</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button className="btn primary" onClick={add} disabled={busy || !name.trim()}>
          {busy ? "추가 중…" : "추가"}
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
      <table className="mini wide">
        <thead>
          <tr>
            <th>선박명</th>
            <th>IMO</th>
            <th>소속 고객</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.imo || "—"}</td>
              <td>{r.customer || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
