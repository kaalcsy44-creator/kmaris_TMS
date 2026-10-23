"use client";

/**
 * 고객사의 역할 — 배에 대해 어떤 자리에 있는 회사인가(Owner·Ship manager·…).
 *
 * 부품 영업에서 이 구분이 중요한 까닭: 등록 선주는 대개 1척짜리 SPV 라 연락할 상대가 아니고,
 * 실제로 부품을 사는 곳은 관리사다. 선주이면서 직접 관리하는 곳도 흔해 여럿을 고른다.
 * 서버(routers/settings.CUSTOMER_ROLES)와 같은 이름·같은 차례.
 */

export const CUSTOMER_ROLES = ["Owner", "Ship manager", "Operator", "Agent / Broker", "Other"] as const;

const SHORT: Record<string, string> = {
  "Owner": "Owner",
  "Ship manager": "Manager",
  "Operator": "Operator",
  "Agent / Broker": "Agent",
  "Other": "Other",
};

const roleClass = (r: string) => "cr-chip cr-" + (SHORT[r] || "Other").toLowerCase();

/** 목록·창의 칩. suggested = 선박 데이터가 가리키지만 아직 안 붙은 역할(점선 + ?). */
export function RoleBadges({ roles, suggested = [] }: { roles: string[]; suggested?: { role: string; vessels: string[] }[] }) {
  if (!roles.length && !suggested.length) return <span className="dash">—</span>;
  return (
    <span className="cr-chips">
      {roles.map((r) => (
        <span key={r} className={roleClass(r)} title={r}>{SHORT[r] || r}</span>
      ))}
      {suggested.map((s) => (
        <span key={"s" + s.role} className={roleClass(s.role) + " cr-sugg"}
              title={`Suggested from vessel data — ${s.role} of ${s.vessels.length} vessel(s): ${s.vessels.join(", ")}`}>
          {SHORT[s.role] || s.role}?
        </span>
      ))}
    </span>
  );
}

/** 편집 칸 — 칩을 눌러 켜고 끈다. */
export function RolePicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  return (
    <label className="form-field">
      <span>Role</span>
      <span className="cr-picker">
        {CUSTOMER_ROLES.map((r) => {
          const on = value.includes(r);
          return (
            <button
              key={r}
              type="button"
              className={roleClass(r) + (on ? " on" : " off")}
              aria-pressed={on}
              onClick={() => onChange(CUSTOMER_ROLES.filter((x) => (x === r ? !on : value.includes(x))))}
            >
              {on ? "✓ " : ""}{r}
            </button>
          );
        })}
      </span>
    </label>
  );
}

/** 서버가 정한 차례로 합친다(칩 순서가 늘 같게). */
export function mergeRoles(a: string[], b: string[]): string[] {
  return CUSTOMER_ROLES.filter((r) => a.includes(r) || b.includes(r));
}
