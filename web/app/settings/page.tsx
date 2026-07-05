"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  createSettingsCustomer,
  createSettingsItem,
  createSettingsUser,
  createSettingsVendor,
  createSettingsVessel,
  changeMyPassword,
  deleteSettingsCustomer,
  deleteSettingsItem,
  deleteSettingsUser,
  deleteSettingsVendor,
  deleteSettingsVessel,
  fetchCompanyProfile,
  fetchCustomers,
  fetchSettingsCustomers,
  fetchSettingsItems,
  fetchSettingsUsers,
  fetchSettingsVendors,
  fetchSettingsVessels,
  updateCompanyProfile,
  updateSettingsCustomer,
  updateSettingsItem,
  updateSettingsUser,
  updateSettingsVendor,
  updateSettingsVessel,
  fetchRolePermissions,
  updateRolePermissions,
  fetchItemCategories,
  createItemCategory,
  updateItemCategory,
  deleteItemCategory,
} from "@/lib/api";
import type { PermissionsConfig, RolePermRow } from "@/lib/api";
import type { PermGrid } from "@/lib/auth";
import type {
  CompanyProfile,
  CustomerOption,
  SettingsCustomer,
  SettingsItem,
  ItemCategory,
  SettingsUser,
  SettingsVendor,
  SettingsVessel,
} from "@/lib/types";
import { getUser, isAdmin, can } from "@/lib/auth";
import AppShell, { SectionHead } from "@/components/AppShell";
import Modal from "@/components/common/Modal";
import { invalidateCustomerLogos } from "@/lib/customerLogos";
import { invalidateVendorLogos } from "@/lib/vendorLogos";
import { fileToLogoDataUrl, imageFromClipboard } from "@/lib/imagePaste";

type Tab =
  | "company" | "users" | "permissions"
  | "customers" | "vendors" | "vessels" | "items" | "categories" | "account";

const emptyCompany: CompanyProfile = {
  company_name_en: "",
  company_name_kr: "",
  address: "",
  business_no: "",
  phone: "",
  general_email: "",
  sales_email: "",
  tax_email: "",
  website: "",
  bank_name: "",
  bank_account: "",
  bank_holder: "",
  swift: "",
  tagline: "",
};

export default function SettingsPage() {
  return (
    <AppShell active="settings">
      <Settings />
    </AppShell>
  );
}

function Settings() {
  const admin = isAdmin();
  // 마스터 데이터(고객사·Vendor·선박·품목) 관리 = "settings" 권한. admin 은 항상 허용.
  // 회사/사용자/권한 설정은 admin 전용으로 유지한다.
  const canMaster = admin || can("settings", "view");
  const [tab, setTab] = useState<Tab>(admin ? "company" : canMaster ? "customers" : "account");

  // 마스터 데이터 권한도 없는 사용자(예: 권한 없는 viewer)는 본인 비밀번호 변경만.
  if (!admin && !canMaster) {
    return (
      <>
        <SectionHead title="My Account" sub="Password" />
        <h3 className="form-title">My account</h3>
        <p className="hint-inline" style={{ display: "block", marginBottom: 8 }}>
          Company, user, and master-data settings are available to administrators only.
        </p>
        <MyPasswordChange />
      </>
    );
  }

  // admin: 전체 탭. 비관리자(마스터 권한 보유): 마스터 데이터 탭 + 내 계정만.
  const tabs: { key: Tab; label: string }[] = admin
    ? [
        { key: "company", label: "Company" },
        { key: "users", label: "Users" },
        { key: "permissions", label: "Permissions" },
        { key: "customers", label: "Customer" },
        { key: "vendors", label: "Vendor" },
        { key: "vessels", label: "Vessels" },
        { key: "items", label: "Item Master" },
        { key: "categories", label: "Item 분류" },
      ]
    : [
        { key: "customers", label: "Customer" },
        { key: "vendors", label: "Vendor" },
        { key: "vessels", label: "Vessels" },
        { key: "items", label: "Item Master" },
        { key: "categories", label: "Item 분류" },
        { key: "account", label: "My Account" },
      ];

  return (
    <>
      <SectionHead
        title="Settings"
        sub={admin ? "Company · users · master data" : "Master data"}
      />
      <div className="page-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {admin && tab === "company" && <CompanyTab />}
      {admin && tab === "users" && <UsersTab />}
      {admin && tab === "permissions" && <PermissionsTab />}
      {tab === "customers" && <CustomersTab />}
      {tab === "vendors" && <VendorsTab />}
      {tab === "vessels" && <VesselsTab />}
      {tab === "items" && <ItemsTab />}
      {tab === "categories" && <CategoriesTab />}
      {tab === "account" && (
        <div className="panel">
          <MyPasswordChange />
        </div>
      )}
    </>
  );
}

const COMPANY_FIELDS: { key: keyof CompanyProfile; label: string }[] = [
  { key: "company_name_en", label: "Company Name (EN)" },
  { key: "company_name_kr", label: "Company Name (KR)" },
  { key: "address", label: "Address" },
  { key: "business_no", label: "Business No." },
  { key: "phone", label: "Phone" },
  { key: "general_email", label: "General Email" },
  { key: "sales_email", label: "Sales Email" },
  { key: "tax_email", label: "Tax Email" },
  { key: "website", label: "Website" },
  { key: "bank_name", label: "Bank Name" },
  { key: "bank_account", label: "Bank Account" },
  { key: "bank_holder", label: "Bank Holder" },
  { key: "swift", label: "SWIFT" },
  { key: "tagline", label: "Tagline" },
];

function CompanyTab() {
  const [form, setForm] = useState<CompanyProfile>(emptyCompany);
  const [saved, setSaved] = useState<CompanyProfile>(emptyCompany); // 마지막 저장값(읽기 화면·취소용)
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchCompanyProfile()
      .then((d) => {
        const merged = { ...emptyCompany, ...d };
        setForm(merged);
        setSaved(merged);
      })
      .catch(() => {
        setForm(emptyCompany);
        setSaved(emptyCompany);
      });
  }, []);

  function startEdit() {
    setForm(saved);
    setMsg("");
    setEditing(true);
  }

  function cancel() {
    setForm(saved);
    setEditing(false);
    setMsg("");
  }

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      await updateCompanyProfile(form);
      setSaved(form);
      setEditing(false);
      setMsg("Saved");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  // 저장 후/기본: 정리된 읽기 화면
  if (!editing) {
    return (
      <div className="panel">
        <dl className="company-view">
          {COMPANY_FIELDS.map((f) => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd>{saved[f.key] ? saved[f.key] : <span className="dash">—</span>}</dd>
            </div>
          ))}
        </dl>
        <div className="form-actions">
          <button className="btn primary" onClick={startEdit}>
            ✎ Edit company info
          </button>
          {msg ? <span className="hint-inline">{msg}</span> : null}
        </div>
      </div>
    );
  }

  // 수정: 입력 폼
  return (
    <div className="panel">
      <div className="form-grid">
        {COMPANY_FIELDS.map((f) => (
          <TextField
            key={f.key}
            label={f.label}
            value={form[f.key] || ""}
            onChange={(v) => setForm({ ...form, [f.key]: v })}
          />
        ))}
      </div>
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save company info"}
        </button>
        <button className="btn" disabled={busy} onClick={cancel}>
          Cancel
        </button>
        {msg ? <span className="hint-inline">{msg}</span> : null}
      </div>
    </div>
  );
}

const EMPTY_USER: SettingsUser = { id: 0, username: "", email: "", role: "sales", is_active: true };

// 역할별 권한 설명 — admin 이 계정에 권한을 부여할 때 참고. (백엔드 RBAC 와 일치)
const ROLE_INFO: { key: string; title: string; perms: string[] }[] = [
  {
    key: "admin",
    title: "Admin",
    perms: [
      "All deals: create / edit / delete",
      "Settings: company, users, master data (customers·vendors·vessels·items)",
      "Assign roles to other accounts",
    ],
  },
  {
    key: "sales",
    title: "Sales",
    perms: [
      "Deals: create / edit / delete (RFQ·Quotation·P/O·AR·Documents)",
      "Sees ONLY their own deals",
      "Master data (customer·vendor·vessel·item) if granted in Permissions",
      "No company / user / permission settings",
    ],
  },
  {
    key: "viewer",
    title: "Viewer",
    perms: [
      "Read-only — can view all screens",
      "Cannot create / edit / delete anything",
      "No access to settings",
    ],
  },
];
const ROLE_BY_KEY = Object.fromEntries(ROLE_INFO.map((r) => [r.key, r]));

function UsersTab() {
  const NEW_ID = -1;
  const [rows, setRows] = useState<SettingsUser[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<SettingsUser>(EMPTY_USER);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const me = getUser();
  const isEdit = !!editId && editId > 0;
  const isSelf = isEdit && me?.id === editId;

  function load() {
    fetchSettingsUsers().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : "Failed to load users"));
  }

  useEffect(load, []);

  function openNew() {
    setForm(EMPTY_USER);
    setPassword("");
    setErr("");
    setEditId(NEW_ID);
  }
  function openEdit(u: SettingsUser) {
    setForm(u);
    setPassword("");
    setErr("");
    setEditId(u.id);
  }
  function cancel() {
    setForm(EMPTY_USER);
    setPassword("");
    setErr("");
    setEditId(null);
  }

  async function save() {
    setErr("");
    try {
      const body = { username: form.username, email: form.email, role: form.role, is_active: form.is_active, password };
      if (isEdit) await updateSettingsUser(editId, body);
      else await createSettingsUser(body);
      cancel();
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function remove() {
    if (!isEdit || !confirm("Delete this user?")) return;
    setErr("");
    try {
      await deleteSettingsUser(editId);
      cancel();
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  const editorTitle = isEdit ? `✎ Edit ${form.username || "user"}` : "+ New user";
  const editor = editId !== null ? (
    <Modal title={editorTitle} onClose={cancel} form>
      <div className="form-grid">
        <TextField label="Username *" value={form.username} onChange={(v) => setForm({ ...form, username: v })} />
        <TextField label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
        <label className="form-field">
          <span>Role</span>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="admin">admin</option>
            <option value="sales">sales</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
        <TextField
          label={isEdit ? "New password (if changing)" : "Password *"}
          value={password}
          onChange={setPassword}
          type="password"
        />
        <label className="check-inline">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          Active (inactive blocks login)
        </label>
      </div>
      {ROLE_BY_KEY[form.role] ? (
        <div className="role-perm-note">
          <span className="role-perm-title">{ROLE_BY_KEY[form.role].title} can:</span>
          <ul>
            {ROLE_BY_KEY[form.role].perms.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="form-actions">
        <button className="btn primary" onClick={save} disabled={!form.username.trim() || (!isEdit && !password)}>
          {isEdit ? "Save" : "Add"}
        </button>
        <button className="btn" onClick={cancel}>
          Cancel
        </button>
        {isEdit && !isSelf ? (
          <button className="btn danger" onClick={remove}>
            Delete
          </button>
        ) : null}
        {isSelf ? <span className="hint-inline">For your own account, only deactivation/password change is allowed.</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  ) : null;

  return (
    <div className="panel">
      <div className="ms-toolbar">
        <h3 className="form-title">User management</h3>
        <button className="btn primary" onClick={openNew} disabled={editId === NEW_ID}>
          + Add user
        </button>
      </div>

      {/* 역할별 권한 범례 — admin 이 어떤 권한을 부여하는지 한눈에 본다. */}
      <div className="role-legend">
        {ROLE_INFO.map((r) => (
          <div key={r.key} className="role-legend-card">
            <div className={`role-legend-head role-${r.key}`}>{r.title}</div>
            <ul>
              {r.perms.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {editor}

      {rows.length === 0 ? (
        <div className="state">No users registered.</div>
      ) : (
        <div className="table-wrap">
          <table className="mini wide ms-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th className="ms-actcol"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className={u.id === editId ? "sel" : ""} onClick={() => openEdit(u)}>
                  <td>{u.username}</td>
                  <td>{u.email || "—"}</td>
                  <td><span className={`role-badge role-${u.role}`}>{u.role}</span></td>
                  <td>
                    <span className={`status-badge${u.is_active ? " on" : " off"}`}>
                      {u.is_active ? "✓ Active" : "— Inactive"}
                    </span>
                  </td>
                  <td className="ms-actcol" onClick={(e) => { e.stopPropagation(); openEdit(u); }}>
                    <span className="ms-edit-btn" title="Edit">✎</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MyPasswordChange />
    </div>
  );
}

// ── 권한 매트릭스 편집 (admin 전용) ──────────────────────────────────────────
const MODULE_LABEL: Record<string, string> = {
  dashboard: "Dashboard",
  progress: "Progress",
  rfq: "RFQ & Quotation",
  po: "P/O",
  documents: "Documents",
  ar: "AR",
  marketing: "Marketing",
  settings: "Settings · master data",
};
const ACTION_LABEL: Record<string, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
};
const PERM_ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  sales: "Sales",
  viewer: "Viewer",
};

function clonePerms(p: PermGrid): PermGrid {
  return JSON.parse(JSON.stringify(p));
}

function PermissionsTab() {
  const [cfg, setCfg] = useState<PermissionsConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, { perms: PermGrid; scope: string }>>({});
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  function loadInto(c: PermissionsConfig) {
    const d: Record<string, { perms: PermGrid; scope: string }> = {};
    c.roles.filter((r) => r.editable).forEach((r) => {
      d[r.role] = { perms: clonePerms(r.perms), scope: r.scope };
    });
    setDraft(d);
  }

  useEffect(() => {
    fetchRolePermissions()
      .then((c) => {
        setCfg(c);
        loadInto(c);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  if (err && !cfg) return <div className="state error">{err}</div>;
  if (!cfg) return <div className="state">Loading…</div>;

  const viewOnly = new Set(cfg.view_only);

  function toggle(role: string, module: string, action: string) {
    setDraft((prev) => {
      const cur = prev[role];
      if (!cur) return prev;
      const next = clonePerms(cur.perms);
      next[module] = { ...(next[module] || {}) };
      next[module][action] = !next[module][action];
      // 열람을 끄면 입력/수정/삭제도 무의미하므로 함께 해제.
      if (action === "view" && !next[module][action]) {
        ["create", "edit", "delete"].forEach((a) => (next[module][a] = false));
      }
      return { ...prev, [role]: { ...cur, perms: next } };
    });
    setMsg("");
  }

  function setScope(role: string, scope: string) {
    setDraft((prev) =>
      prev[role] ? { ...prev, [role]: { ...prev[role], scope } } : prev
    );
    setMsg("");
  }

  async function save(role: string) {
    const d = draft[role];
    if (!d) return;
    setSavingRole(role);
    setErr("");
    setMsg("");
    try {
      await updateRolePermissions({ role, perms: d.perms, scope: d.scope });
      setMsg(`${PERM_ROLE_LABEL[role] ?? role} permissions saved.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingRole(null);
    }
  }

  function RoleCard({ row }: { row: RolePermRow }) {
    const editable = row.editable;
    const state = editable ? draft[row.role] : { perms: row.perms, scope: row.scope };
    if (!state) return null;
    return (
      <div className="perm-card">
        <div className={`perm-card-head role-${row.role}`}>
          <span>{PERM_ROLE_LABEL[row.role] ?? row.role}</span>
          {!editable ? <span className="perm-locked">always full access</span> : null}
        </div>
        <div className="table-wrap">
          <table className="mini perm-matrix">
            <thead>
              <tr>
                <th>Page</th>
                {cfg!.actions.map((a) => (
                  <th key={a}>{ACTION_LABEL[a] ?? a}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cfg!.modules.map((m) => (
                <tr key={m}>
                  <td className="perm-mod">{MODULE_LABEL[m] ?? m}</td>
                  {cfg!.actions.map((a) => {
                    const na = viewOnly.has(m) && a !== "view";
                    return (
                      <td key={a} className="perm-cell">
                        {na ? (
                          <span className="perm-na">—</span>
                        ) : (
                          <input
                            type="checkbox"
                            checked={!!state.perms[m]?.[a]}
                            disabled={!editable}
                            onChange={() => toggle(row.role, m, a)}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="perm-scope">
          <span className="perm-scope-label">Data scope:</span>
          <label>
            <input
              type="radio"
              name={`scope-${row.role}`}
              checked={state.scope === "all"}
              disabled={!editable}
              onChange={() => setScope(row.role, "all")}
            />
            All deals
          </label>
          <label>
            <input
              type="radio"
              name={`scope-${row.role}`}
              checked={state.scope === "own"}
              disabled={!editable}
              onChange={() => setScope(row.role, "own")}
            />
            Own deals only
          </label>
        </div>
        {editable ? (
          <div className="form-actions">
            <button
              className="btn primary"
              onClick={() => save(row.role)}
              disabled={savingRole === row.role}
            >
              {savingRole === row.role ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={() => loadInto(cfg!)} disabled={savingRole === row.role}>
              Reset
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="ms-toolbar">
        <h3 className="form-title">Role permissions</h3>
      </div>
      <p className="hint-inline" style={{ display: "block", marginBottom: 12 }}>
        Set per-page View / Create / Edit / Delete for each role, plus whether they see all deals or only their own.
        Admin always has full access. (페이지별 열람·입력·수정·삭제 권한을 역할마다 지정)
      </p>
      {msg ? <div className="action-ok" style={{ marginBottom: 10 }}>{msg}</div> : null}
      {err ? <div className="action-err" style={{ marginBottom: 10 }}>{err}</div> : null}
      <div className="perm-cards">
        {cfg.roles.map((r) => (
          <RoleCard key={r.role} row={r} />
        ))}
      </div>
    </div>
  );
}

function MyPasswordChange() {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const me = getUser();

  async function submit() {
    setErr("");
    setMsg("");
    if (newPw !== newPw2) {
      setErr("New passwords do not match.");
      return;
    }
    try {
      await changeMyPassword(oldPw, newPw);
      setMsg("Password changed.");
      setOldPw("");
      setNewPw("");
      setNewPw2("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Change failed");
    }
  }

  return (
    <div className="subpanel" style={{ marginTop: 20 }}>
      <div className="sub-h">Change my password{me ? ` — ${me.username}` : ""}</div>
      <div className="form-grid">
        <TextField label="Current password" value={oldPw} onChange={setOldPw} type="password" />
        <TextField label="New password" value={newPw} onChange={setNewPw} type="password" />
        <TextField label="Confirm new password" value={newPw2} onChange={setNewPw2} type="password" />
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={submit} disabled={!oldPw || !newPw || !newPw2}>
          Change password
        </button>
        {err ? <span className="action-err">{err}</span> : null}
        {msg ? <span className="action-ok">{msg}</span> : null}
      </div>
    </div>
  );
}

function CustomersTab() {
  return (
    <MasterSection<SettingsCustomer>
      title="Customer Management"
      empty={{ id: 0, name: "", contact: "", contact_phone: "", email: "", country: "", address: "", tax_id: "", logo: "" }}
      load={fetchSettingsCustomers}
      create={createSettingsCustomer}
      update={updateSettingsCustomer}
      remove={deleteSettingsCustomer}
      onSaved={invalidateCustomerLogos}
      columns={[
        ["name", "Customer", (r) => (
          <span className="cust-name">
            {r.logo ? <img className="cust-logo" src={r.logo} alt="" /> : null}
            <span className="cust-name-text">{r.name || "—"}</span>
          </span>
        )],
        ["country", "Country"],
        ["contact", "Contact"],
        ["email", "Email"],
      ]}
      fields={[
        ["name", "Customer *"],
        ["country", "Country"],
        ["address", "Address"],
        ["contact", "Contact name"],
        ["contact_phone", "Contact phone"],
        ["email", "Contact email"],
        ["tax_id", "Tax ID / Business No."],
      ]}
      required="name"
      extraForm={(form, setForm) => (
        <LogoPasteField
          value={form.logo}
          onChange={(logo) => setForm({ ...form, logo })}
        />
      )}
      allowCopy
      copyHint="To register another contact for the same customer, change only the contact/email and save."
    />
  );
}

// 회사 로고 붙여넣기 필드 — 캡쳐본을 Ctrl+V 로 붙이거나 파일 선택으로 등록.
// 이미지는 96px 로 축소한 data URL 로 저장된다.
function LogoPasteField({
  value,
  onChange,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function useFile(file: File | null) {
    if (!file) return;
    setBusy(true);
    setErr("");
    try {
      onChange(await fileToLogoDataUrl(file));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Image error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="form-field logo-field">
      <span>Company logo</span>
      <div
        className="logo-drop"
        tabIndex={0}
        onPaste={(e) => {
          const img = imageFromClipboard(e);
          if (img) {
            e.preventDefault();
            useFile(img);
          }
        }}
      >
        {value ? (
          <img className="logo-preview" src={value} alt="logo" />
        ) : (
          <span className="logo-hint">Click here and paste (Ctrl+V), or choose a file</span>
        )}
      </div>
      <div className="logo-actions">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          onChange={(e) => useFile(e.target.files?.[0] ?? null)}
        />
        {value ? (
          <button type="button" className="btn" onClick={() => onChange("")}>
            Remove
          </button>
        ) : null}
        {busy ? <span className="hint-inline">Processing…</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </label>
  );
}

function VendorsTab() {
  return (
    <MasterSection<SettingsVendor>
      title="Vendor Management"
      empty={{ id: 0, name: "", contact: "", contact_phone: "", email: "", specialization: "", country: "", address: "", logo: "" }}
      load={fetchSettingsVendors}
      create={createSettingsVendor}
      update={updateSettingsVendor}
      remove={deleteSettingsVendor}
      onSaved={invalidateVendorLogos}
      columns={[
        ["name", "Vendor", (r) => (
          <span className="cust-name">
            {r.logo ? <img className="cust-logo" src={r.logo} alt="" /> : null}
            <span className="cust-name-text">{r.name || "—"}</span>
          </span>
        )],
        ["country", "Country"],
        ["contact", "Contact"],
        ["email", "Email"],
        ["specialization", "Specialization"],
      ]}
      fields={[
        ["name", "Vendor *"],
        ["country", "Country"],
        ["address", "Address"],
        ["contact", "Contact name"],
        ["contact_phone", "Contact phone"],
        ["email", "Contact email"],
        ["specialization", "Specialization"],
      ]}
      required="name"
      extraForm={(form, setForm) => (
        <LogoPasteField
          value={form.logo}
          onChange={(logo) => setForm({ ...form, logo })}
        />
      )}
      allowCopy
      copyHint="To register another contact for the same vendor, change only the contact/email and save."
    />
  );
}

function VesselsTab() {
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  useEffect(() => {
    fetchCustomers().then(setCustomers).catch(() => setCustomers([]));
  }, []);

  return (
    <MasterSection<SettingsVessel>
      title="Vessel Management"
      empty={{ id: 0, name: "", imo: "", vessel_type: "", ais_flag: "", engine_type: "", hull_no: "", customer_id: null, customer: "" }}
      load={fetchSettingsVessels}
      create={(body) => {
        const { customer: _customer, ...payload } = body;
        return createSettingsVessel({ ...payload, customer_id: payload.customer_id ?? undefined });
      }}
      update={(id, body) => {
        const { customer: _customer, ...payload } = body;
        return updateSettingsVessel(id, payload);
      }}
      remove={deleteSettingsVessel}
      columns={[
        ["name", "Vessel"],
        ["imo", "IMO"],
        ["vessel_type", "Vessel type"],
        ["ais_flag", "AIS Flag"],
        ["customer", "Customer"],
      ]}
      fields={[
        ["name", "Vessel *"],
        ["imo", "IMO No."],
        ["ais_flag", "AIS Flag (flag state)"],
        ["engine_type", "Main Engine Type"],
        ["hull_no", "Hull No."],
      ]}
      required="name"
      extraForm={(form, setForm) => (
        <>
          <label className="form-field">
            <span>Vessel type</span>
            <input
              list="vessel-type-list"
              value={form.vessel_type ?? ""}
              onChange={(e) => setForm({ ...form, vessel_type: e.target.value })}
              placeholder="Select or type"
            />
            <datalist id="vessel-type-list">
              {VESSEL_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="form-field">
            <span>Owner Customer</span>
            <select
              value={form.customer_id ?? ""}
              onChange={(e) => setForm({ ...form, customer_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">None</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </>
      )}
    />
  );
}

const VESSEL_TYPES = [
  "Container Ship",
  "Crude Oil Tanker",
  "Product Tanker",
  "Chemical Tanker",
  "Bulk Carrier",
  "Bunkering Tanker",
  "LNG Carrier",
  "LPG Carrier",
  "General Cargo",
  "Car Carrier (PCTC)",
  "Reefer",
  "Passenger / Ro-Pax",
  "Tug / Offshore",
];

function ItemsTab() {
  return (
    <MasterSection<SettingsItem>
      title="Item Master"
      empty={{ id: 0, part_no: "", description: "", maker: "", origin: "", unit: "PCS", hs_code: "", std_price: 0, category_id: null, category_path: "" }}
      load={fetchSettingsItems}
      create={createSettingsItem}
      update={updateSettingsItem}
      remove={deleteSettingsItem}
      columns={[
        ["part_no", "Part No."],
        ["category_path", "분류", (r) => r.category_path
          ? <span className="cat-path">{r.category_path}</span>
          : <span className="dash">미분류</span>],
        ["description", "Description"],
        ["maker", "Maker"],
        ["origin", "Origin"],
        ["unit", "Unit"],
        ["hs_code", "HS Code"],
        ["std_price", "Std Price"],
      ]}
      fields={[
        ["part_no", "Part No. *"],
        ["description", "Description"],
        ["maker", "Maker"],
        ["origin", "Origin"],
        ["unit", "Unit"],
        ["hs_code", "HS Code"],
        ["std_price", "Std Price"],
      ]}
      required="part_no"
      numeric={["std_price"]}
      extraForm={(form, setForm) => (
        <CategoryPicker
          value={form.category_id}
          onChange={(category_id) => setForm({ ...form, category_id })}
        />
      )}
    />
  );
}

// 품목 분류 캐스케이딩 선택(대>중>소). value=가장 깊은 선택 노드 id. 미분류=null.
// 저장은 항상 '가장 깊게 선택된' 노드를 value 로 둔다(대만 선택→대 id, 소까지→소 id).
function CategoryPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [cats, setCats] = useState<ItemCategory[]>([]);
  useEffect(() => {
    fetchItemCategories().then(setCats).catch(() => setCats([]));
  }, []);

  const byId = new Map(cats.map((c) => [c.id, c]));
  // 현재 value 로부터 조상 체인 [대, 중, 소] 복원.
  const chain: number[] = [];
  let cur = value != null ? byId.get(value) : undefined;
  let guard = 0;
  while (cur && guard++ < 5) {
    chain.unshift(cur.id);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
  }
  const l1 = chain[0] ?? null;
  const l2 = chain[1] ?? null;
  const l3 = chain[2] ?? null;

  const opts = (level: number, parent: number | null) =>
    cats
      .filter((c) => c.level === level && (c.parent_id ?? null) === parent && c.active)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  const l1Opts = opts(1, null);
  const l2Opts = l1 != null ? opts(2, l1) : [];
  const l3Opts = l2 != null ? opts(3, l2) : [];

  return (
    <label className="form-field cat-picker">
      <span>분류 (대 · 중 · 소)</span>
      <div className="cat-picker-row">
        <select value={l1 ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
          <option value="">대분류</option>
          {l1Opts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={l2 ?? ""}
          disabled={l1 == null || l2Opts.length === 0}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : l1)}
        >
          <option value="">{l1 == null ? "—" : "중분류"}</option>
          {l2Opts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={l3 ?? ""}
          disabled={l2 == null || l3Opts.length === 0}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : l2)}
        >
          <option value="">{l2 == null ? "—" : "소분류"}</option>
          {l3Opts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {value == null ? <span className="hint-inline">미분류 — 대분류부터 선택하세요.</span> : null}
    </label>
  );
}

const LEVEL_LABEL: Record<number, string> = { 1: "대분류", 2: "중분류", 3: "소분류" };
const CHILD_LABEL: Record<number, string> = { 1: "+ 중분류", 2: "+ 소분류" };

type CatEditor = {
  id: number | null;        // null=신규
  parent_id: number | null;
  level: number;
  name: string;
  active: boolean;
  parentPath: string;       // 상위 경로 표시용
};

// 품목 분류 트리(대>중>소) 관리 탭. 마스터 데이터 권한(settings)으로 편집.
function CategoriesTab() {
  const [rows, setRows] = useState<ItemCategory[]>([]);
  const [editor, setEditor] = useState<CatEditor | null>(null);
  const [err, setErr] = useState("");
  const canCreate = can("settings", "create");
  const canEdit = can("settings", "edit");
  const canDelete = can("settings", "delete");

  function refresh() {
    fetchItemCategories().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }
  useEffect(refresh, []);

  const byId = new Map(rows.map((c) => [c.id, c]));
  const childrenOf = (pid: number | null) =>
    rows
      .filter((c) => (c.parent_id ?? null) === pid)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  function openNew(parent: ItemCategory | null) {
    setErr("");
    setEditor({
      id: null,
      parent_id: parent ? parent.id : null,
      level: parent ? (parent.level || 1) + 1 : 1,
      name: "",
      active: true,
      parentPath: parent ? parent.path : "",
    });
  }
  function openEdit(node: ItemCategory) {
    setErr("");
    const parent = node.parent_id != null ? byId.get(node.parent_id) : undefined;
    setEditor({
      id: node.id,
      parent_id: node.parent_id,
      level: node.level,
      name: node.name,
      active: node.active,
      parentPath: parent ? parent.path : "",
    });
  }
  function cancel() {
    setEditor(null);
    setErr("");
  }

  async function save() {
    if (!editor) return;
    setErr("");
    try {
      if (editor.id == null) {
        const siblings = childrenOf(editor.parent_id).length;
        await createItemCategory({
          name: editor.name.trim(),
          parent_id: editor.parent_id,
          sort_order: siblings,
          active: editor.active,
        });
      } else {
        await updateItemCategory(editor.id, { name: editor.name.trim(), active: editor.active });
      }
      cancel();
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function del(node: ItemCategory) {
    if (!confirm(`'${node.name}' 분류를 삭제할까요?`)) return;
    setErr("");
    try {
      await deleteItemCategory(node.id);
      refresh();
    } catch (e) {
      // 하위 분류/사용 중 품목이 있으면 백엔드가 막는다.
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  function NodeRow({ node }: { node: ItemCategory }) {
    const kids = childrenOf(node.id);
    return (
      <li className={`cat-node cat-l${node.level}${node.active ? "" : " off"}`}>
        <div className="cat-node-row">
          <span className="cat-node-name">
            {node.name}
            {!node.active ? <span className="cat-inactive">비활성</span> : null}
          </span>
          <span className="cat-node-actions">
            {node.level < 3 && canCreate ? (
              <button className="btn tiny" onClick={() => openNew(node)}>{CHILD_LABEL[node.level]}</button>
            ) : null}
            {canEdit ? (
              <button className="btn tiny" onClick={() => openEdit(node)} title="수정">✎</button>
            ) : null}
            {canDelete ? (
              <button className="btn tiny danger" onClick={() => del(node)} title="삭제">🗑</button>
            ) : null}
          </span>
        </div>
        {kids.length ? (
          <ul className="cat-children">
            {kids.map((k) => <NodeRow key={k.id} node={k} />)}
          </ul>
        ) : null}
      </li>
    );
  }

  const roots = childrenOf(null);
  const editorTitle = editor
    ? editor.id == null
      ? `+ ${LEVEL_LABEL[editor.level] ?? "분류"} 추가`
      : `✎ ${LEVEL_LABEL[editor.level] ?? "분류"} 수정 — ${editor.name || ""}`
    : "";

  return (
    <div className="panel">
      <div className="ms-toolbar">
        <h3 className="form-title">Item 분류 (대 · 중 · 소)</h3>
        {canCreate ? (
          <button className="btn primary" onClick={() => openNew(null)}>+ 대분류</button>
        ) : null}
      </div>
      <p className="hint-inline" style={{ display: "block", marginBottom: 12 }}>
        품목 분류 체계를 관리합니다. 대분류 &gt; 중분류 &gt; 소분류(최대 3단계). 하위 분류나 사용 중인 품목이 있는 분류는 삭제할 수 없습니다.
      </p>

      {err ? <div className="action-err" style={{ marginBottom: 10 }}>{err}</div> : null}

      {roots.length === 0 ? (
        <div className="state">분류가 없습니다. &quot;+ 대분류&quot;로 시작하세요.</div>
      ) : (
        <ul className="cat-tree">
          {roots.map((r) => <NodeRow key={r.id} node={r} />)}
        </ul>
      )}

      {editor ? (
        <Modal title={editorTitle} onClose={cancel} form>
          <div className="form-grid">
            {editor.parentPath ? (
              <div className="form-field" style={{ gridColumn: "1 / -1" }}>
                <span>상위 분류</span>
                <div className="cat-parent-path">{editor.parentPath}</div>
              </div>
            ) : null}
            <TextField
              label={`${LEVEL_LABEL[editor.level] ?? "분류"}명 *`}
              value={editor.name}
              onChange={(v) => setEditor({ ...editor, name: v })}
            />
            <label className="check-inline">
              <input
                type="checkbox"
                checked={editor.active}
                onChange={(e) => setEditor({ ...editor, active: e.target.checked })}
              />
              활성 (비활성 시 선택 목록에서 숨김)
            </label>
          </div>
          <div className="form-actions">
            <button className="btn primary" onClick={save} disabled={!editor.name.trim()}>
              {editor.id == null ? "추가" : "저장"}
            </button>
            <button className="btn" onClick={cancel}>취소</button>
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function MasterSection<T extends { id: number }>({
  title,
  empty,
  load,
  create,
  update,
  remove,
  columns,
  fields,
  required,
  numeric = [],
  extraForm,
  allowCopy = false,
  copyHint,
  onSaved,
}: {
  title: string;
  empty: T;
  load: () => Promise<T[]>;
  create: (body: Omit<T, "id">) => Promise<unknown>;
  update: (id: number, body: Omit<T, "id">) => Promise<unknown>;
  remove: (id: number) => Promise<unknown>;
  // 각 컬럼: [키, 헤더라벨, (선택)셀 커스텀 렌더]
  columns: [keyof T, string, ((row: T) => ReactNode)?][];
  fields: [keyof T, string][];
  required: keyof T;
  numeric?: (keyof T)[];
  extraForm?: (form: T, setForm: (next: T) => void) => ReactNode;
  allowCopy?: boolean; // 기존 항목 정보를 복사해 새 레코드로 등록 허용
  copyHint?: string; // 복사 모드 안내 문구
  onSaved?: () => void; // 생성/수정/삭제 성공 후 호출(예: 로고 캐시 무효화)
}) {
  const NEW_ID = -1; // editId 센티넬: 신규 등록 편집기
  const [rows, setRows] = useState<T[]>([]);
  const [editId, setEditId] = useState<number | null>(null); // null=닫힘, -1=신규, >0=수정
  const [form, setForm] = useState<T>(empty);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [copying, setCopying] = useState(false); // 복사 모드(기존 정보 복제 → 새 레코드)
  // 마스터 데이터 입력·수정·삭제 권한(= "settings" 모듈). admin 은 항상 true.
  const canCreate = can("settings", "create");
  const canEdit = can("settings", "edit");
  const canDelete = can("settings", "delete");

  function refresh() {
    load().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }

  useEffect(refresh, []);

  function openNew() {
    setForm(empty);
    setErr("");
    setCopying(false);
    setEditId(NEW_ID);
  }
  function openEdit(row: T) {
    setForm(row);
    setErr("");
    setCopying(false);
    setEditId(row.id);
  }
  // 현재 편집 중인 항목의 정보를 그대로 둔 채 '신규 등록'으로 전환한다(저장 시 새 레코드 생성).
  function copyAsNew() {
    setForm({ ...form, id: 0 });
    setErr("");
    setCopying(true);
    setEditId(NEW_ID);
  }
  function cancel() {
    setForm(empty);
    setErr("");
    setCopying(false);
    setEditId(null);
  }

  async function save() {
    setErr("");
    try {
      const body = stripId(form);
      if (editId && editId > 0) await update(editId, body);
      else await create(body);
      cancel();
      refresh();
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function delRow() {
    if (!editId || editId < 0 || !confirm("Delete the selected item?")) return;
    setErr("");
    try {
      await remove(editId);
      cancel();
      refresh();
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  const requiredValue = String(form[required] ?? "").trim();
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? rows.filter((r) => columns.some(([key]) => String(r[key] ?? "").toLowerCase().includes(ql)))
    : rows;
  const isEdit = !!editId && editId > 0;

  const editorTitle = isEdit
    ? `✎ Edit ${String(form[required] ?? "") || "item"}`
    : copying
    ? `📋 Copy as new${String(form[required] ?? "") ? ` — ${String(form[required])}` : ""}`
    : "+ New";
  const editor = editId !== null ? (
    <Modal title={editorTitle} onClose={cancel} form>
      {copying && copyHint ? <div className="ms-copy-hint">{copyHint}</div> : null}
      <div className="form-grid">
        {fields.map(([key, label]) => (
          <TextField
            key={String(key)}
            label={label}
            type={numeric.includes(key) ? "number" : "text"}
            value={String(form[key] ?? "")}
            onChange={(v) => setForm({ ...form, [key]: numeric.includes(key) ? Number(v) : v })}
          />
        ))}
        {extraForm?.(form, setForm)}
      </div>
      <div className="form-actions">
        {(isEdit ? canEdit : canCreate) ? (
          <button className="btn primary" disabled={!requiredValue} onClick={save}>
            {isEdit ? "Save" : "Add"}
          </button>
        ) : null}
        {isEdit && allowCopy && canCreate ? (
          <button className="btn" onClick={copyAsNew} title="Copy this info into a new record">
            📋 Copy as new
          </button>
        ) : null}
        <button className="btn" onClick={cancel}>
          Cancel
        </button>
        {isEdit && canDelete ? (
          <button className="btn danger" onClick={delRow}>
            Delete
          </button>
        ) : null}
        {isEdit && !canEdit ? (
          <span className="hint-inline">View only — your role cannot edit master data.</span>
        ) : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  ) : null;

  return (
    <div className="panel">
      <div className="ms-toolbar">
        <h3 className="form-title">{title}</h3>
        <input
          className="ms-search"
          placeholder="🔍 Search…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {canCreate ? (
          <button className="btn primary" onClick={openNew} disabled={editId === NEW_ID}>
            + New
          </button>
        ) : null}
      </div>

      {editor}

      {filtered.length === 0 ? (
        <div className="state">{ql ? "No search results." : "No items registered."}</div>
      ) : (
        <div className="table-wrap">
          <table className="mini wide ms-table">
            <thead>
              <tr>
                {columns.map(([, label]) => (
                  <th key={label}>{label}</th>
                ))}
                <th className="ms-actcol"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.id}
                  className={row.id === editId ? "sel" : ""}
                  onClick={() => openEdit(row)}
                >
                  {columns.map(([key, , renderCell]) => (
                    <td key={String(key)}>
                      {renderCell ? renderCell(row) : String(row[key] ?? "") || "—"}
                    </td>
                  ))}
                  <td
                    className="ms-actcol"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEdit(row);
                    }}
                  >
                    <span className="ms-edit-btn" title="Edit">
                      ✎
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function stripId<T extends { id: number }>(row: T): Omit<T, "id"> {
  const { id: _id, ...rest } = row;
  return rest;
}
