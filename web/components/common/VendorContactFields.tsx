"use client";

// 벤더 + 담당자 — 한 회사가 목록에 여러 번 서지 않게.
//
// 벤더 레코드는 담당자 한 명이 한 줄이라(Settings 의 "Copy as new"), 담당자가 셋이면
// 드롭다운에 같은 회사 이름이 셋 뜬다. 고르는 사람은 회사를 먼저 떠올리는데 목록은
// 사람을 먼저 묻는 꼴이라, 이름이 같은 세 줄 중 어느 것을 골라야 하는지 알 수 없었다.
//
// 그래서 회사로 한 번 묶어 고르고, 담당자는 그 회사 안에서 따로 고른다. 한 회사의
// 여러 사람에게 같은 RFQ 를 보내는 일이 흔해 담당자는 여럿 고를 수 있다 — 그때도
// 발신은 한 건이다(회사 한 곳에 보낸 한 통이지, 두 곳에 보낸 두 건이 아니다).
// 고른 담당자 중 첫 사람이 대표로 저장되고(vendor_id), 나머지는 받는 사람 주소에
// 함께 실린다.
import { useEffect, useMemo, useRef, useState } from "react";
import type { VendorOption } from "@/lib/types";
import VendorSelect from "@/components/common/VendorSelect";

type Company = {
  key: string;
  name: string;
  repId: number;        // 회사를 고르면 기본으로 잡히는 담당자
  logo?: string;
  uses: number;         // 회사 전체 거래 건수(담당자별 합) — VendorSelect 의 Frequent 판정
  contacts: VendorOption[];
};

/** 벤더 레코드(=담당자 1명)를 회사 단위로 묶는다. 회사 차례는 받은 순서(이름순) 그대로. */
export function groupVendorContacts(vendors: VendorOption[]): Company[] {
  const map = new Map<string, Company>();
  for (const v of vendors) {
    // 같은 회사를 한 줄로 묶는 열쇠 — 대소문자·군더더기 공백은 무시한다.
    const key = (v.name || "").trim().toLowerCase().replace(/\s+/g, " ") || `#${v.id}`;
    const cur = map.get(key);
    if (cur) {
      cur.contacts.push(v);
      cur.uses += v.uses ?? 0;
      if (!cur.logo && v.logo) cur.logo = v.logo;
    } else {
      map.set(key, {
        key,
        name: (v.name || "").trim() || "(no name)",
        repId: v.id,
        logo: v.logo,
        uses: v.uses ?? 0,
        contacts: [v],
      });
    }
  }
  for (const c of map.values()) {
    // 대표는 그 회사에서 가장 많이 거래한 담당자. 같으면 먼저 등록된 쪽이다.
    c.contacts.sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0) || a.id - b.id);
    c.repId = c.contacts[0].id;
  }
  return [...map.values()];
}

/** 고른 담당자들의 받는 사람 주소 한 줄. 빈 값·중복은 걸러 낸다. */
export function vendorContactEmails(vendors: VendorOption[], ids: number[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const email = (vendors.find((v) => v.id === id)?.email || "").trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(email);
  }
  return out.join(", ");
}

/** 저장된 벤더(대표 담당자) + 받는 사람 주소 → 그때 고른 담당자들. 저장 형식은 예나
 *  지금이나 "대표 1명 + 주소 한 줄"이라, 주소에 이름이 오른 같은 회사 담당자를 도로
 *  찾아 체크해 준다(옛 기록도 열면 그대로 보인다). */
export function contactIdsFromEmail(
  vendors: VendorOption[],
  vendorId: number | "",
  email: string
): number[] {
  if (!vendorId) return [];
  const company = groupVendorContacts(vendors).find((c) =>
    c.contacts.some((x) => x.id === vendorId)
  );
  if (!company) return [];
  const addrs = new Set(
    (email || "").split(/[,;]/).map((a) => a.trim().toLowerCase()).filter(Boolean)
  );
  return company.contacts
    .filter((c) => c.id === vendorId || (c.email && addrs.has(c.email.trim().toLowerCase())))
    .map((c) => c.id);
}

/** 담당자 한 줄에 보일 이름 — 이름이 없으면 메일 주소, 그것도 없으면 자리만 지킨다. */
function contactName(v: VendorOption): string {
  return (v.contact || "").trim() || (v.email || "").trim() || "(no contact name)";
}

// Vendor·Contact 두 칸을 함께 낸다 — 부모의 .form-grid 안에 그대로 들어간다.
export default function VendorContactFields({
  vendors,
  value,
  onChange,
  disabled = false,
}: {
  vendors: VendorOption[];
  /** 고른 담당자 레코드 id. 첫 번째가 대표(저장되는 vendor_id). */
  value: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}) {
  const companies = useMemo(() => groupVendorContacts(vendors), [vendors]);
  const company = useMemo(
    () => (value.length ? companies.find((c) => c.contacts.some((x) => x.id === value[0])) ?? null : null),
    [companies, value]
  );
  const companyOptions = useMemo(
    () =>
      companies.map((c) => ({
        id: c.repId,
        name: c.name,
        logo: c.logo,
        uses: c.uses,
        // 담당자가 여럿인 회사는 그 사실을 여기서 미리 알려 준다 — 옆 칸을 열어 보기 전에.
        label:
          c.contacts.length > 1 ? (
            <>
              {c.name}
              <span className="vcon-sub"> · {c.contacts.length} contacts</span>
            </>
          ) : undefined,
      })),
    [companies]
  );

  function pickCompany(repId: number | "") {
    if (repId === "") {
      onChange([]);
      return;
    }
    const c = companies.find((x) => x.repId === repId);
    onChange(c ? [c.repId] : []);
  }

  function toggleContact(id: number) {
    if (!company) return;
    const next = new Set(value);
    if (next.has(id)) {
      // 마지막 한 명은 빼지 않는다 — 아무도 없는 벤더는 뜻이 없다.
      // 벤더 자체를 지우려면 옆 Vendor 칸에서 선택을 푼다.
      if (next.size === 1) return;
      next.delete(id);
    } else {
      next.add(id);
    }
    // 차례는 클릭 순서가 아니라 목록 차례로 고정한다 — 대표(첫 사람)가 클릭 순서에
    // 따라 바뀌면 저장되는 벤더가 조작 순서에 휘둘린다.
    onChange(company.contacts.filter((c) => next.has(c.id)).map((c) => c.id));
  }

  return (
    <>
      <div className="form-field">
        <label>Vendor</label>
        <VendorSelect
          value={company ? company.repId : ""}
          options={companyOptions}
          onChange={pickCompany}
          disabled={disabled}
        />
      </div>
      <div className="form-field">
        <label>Contact</label>
        <ContactSelect
          company={company}
          value={value}
          onToggle={toggleContact}
          disabled={disabled}
        />
      </div>
    </>
  );
}

// 담당자 복수 선택 — 고를 때마다 닫지 않는다(한 회사에서 이어서 여럿 체크한다).
function ContactSelect({
  company,
  value,
  onToggle,
  disabled,
}: {
  company: Company | null;
  value: number[];
  onToggle: (id: number) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  // 벤더가 바뀌면 열려 있던 목록은 닫는다(이전 회사의 담당자가 잠깐 남아 보이지 않게).
  useEffect(() => setOpen(false), [company?.key]);

  const picked = company ? company.contacts.filter((c) => value.includes(c.id)) : [];
  const off = disabled || !company;

  return (
    <div className={"vsel vcon" + (off ? " disabled" : "")} ref={ref}>
      <button
        type="button"
        className="vsel-btn"
        disabled={off}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="vsel-label">
          {picked.length === 0 ? (
            <span className="vsel-placeholder">
              {company ? "Select contact…" : "Select a vendor first"}
            </span>
          ) : (
            <span className="vsel-name">
              {contactName(picked[0])}
              {picked.length > 1 ? <span className="vcon-more"> +{picked.length - 1}</span> : null}
            </span>
          )}
        </span>
        <span className="vsel-caret" aria-hidden>▾</span>
      </button>
      {open && company ? (
        <ul className="vsel-list" role="listbox" aria-multiselectable="true">
          {company.contacts.map((c) => {
            const on = value.includes(c.id);
            return (
              <li
                key={c.id}
                className={"vsel-item vcon-item" + (on ? " on" : "")}
                role="option"
                aria-selected={on}
                onClick={() => onToggle(c.id)}
              >
                <span className={"vcon-check" + (on ? " on" : "")} aria-hidden>
                  {on ? "✓" : ""}
                </span>
                <span className="vcon-lines">
                  <span className="vcon-name">{contactName(c)}</span>
                  {/* 주소는 곁들이는 정보지만 담당자를 가르는 실제 열쇠라 함께 보여 준다. */}
                  <span className="vcon-mail">{(c.email || "").trim() || "(no email)"}</span>
                </span>
              </li>
            );
          })}
          <li className="vcon-foot">
            <span>{value.length} selected</span>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              Done
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
