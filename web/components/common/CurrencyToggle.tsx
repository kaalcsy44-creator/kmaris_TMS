"use client";

const CURRENCIES = ["USD", "KRW", "CNY", "EUR", "JPY", "SGD"];

export default function CurrencyToggle({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = value || "USD";
  return (
    <select className="currency-select" value={selected} onChange={(e) => onChange(e.target.value)}>
      {CURRENCIES.map((currency) => (
        <option key={currency} value={currency}>
          {currency}
        </option>
      ))}
    </select>
  );
}
