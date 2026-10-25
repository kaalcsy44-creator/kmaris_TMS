"use client";

// 기국(AIS Flag) 이름 좌측에 국기를 작게 붙인다.
// 국기 이모지는 Windows 에서 글자 두 개(LR)로만 보여서, flagcdn 의 PNG 를 쓴다.
// 이름→ISO 코드 표에 없는 값은 국기 없이 글자만 보인다.

const ISO: Record<string, string> = {
  "afghanistan": "af", "albania": "al", "algeria": "dz", "angola": "ao", "antigua and barbuda": "ag",
  "antigua & barbuda": "ag", "argentina": "ar", "australia": "au", "austria": "at", "azerbaijan": "az",
  "bahamas": "bs", "the bahamas": "bs", "bahrain": "bh", "bangladesh": "bd", "barbados": "bb",
  "belgium": "be", "belize": "bz", "benin": "bj", "bermuda": "bm", "bolivia": "bo", "brazil": "br",
  "brunei": "bn", "bulgaria": "bg", "cambodia": "kh", "cameroon": "cm", "canada": "ca",
  "cape verde": "cv", "cabo verde": "cv", "cayman islands": "ky", "chile": "cl", "china": "cn",
  "colombia": "co", "comoros": "km", "congo": "cg", "cook islands": "ck", "costa rica": "cr",
  "croatia": "hr", "cuba": "cu", "curacao": "cw", "curaçao": "cw", "cyprus": "cy",
  "czech republic": "cz", "denmark": "dk", "djibouti": "dj", "dominica": "dm",
  "dominican republic": "do", "ecuador": "ec", "egypt": "eg", "equatorial guinea": "gq",
  "eritrea": "er", "estonia": "ee", "ethiopia": "et", "faroe islands": "fo", "fiji": "fj",
  "finland": "fi", "france": "fr", "gabon": "ga", "gambia": "gm", "georgia": "ge", "germany": "de",
  "ghana": "gh", "gibraltar": "gi", "greece": "gr", "grenada": "gd", "guatemala": "gt",
  "guinea": "gn", "guinea-bissau": "gw", "guyana": "gy", "haiti": "ht", "honduras": "hn",
  "hong kong": "hk", "hong kong, china": "hk", "hungary": "hu", "iceland": "is", "india": "in",
  "indonesia": "id", "iran": "ir", "iraq": "iq", "ireland": "ie", "isle of man": "im",
  "israel": "il", "italy": "it", "ivory coast": "ci", "cote d'ivoire": "ci", "jamaica": "jm",
  "japan": "jp", "jordan": "jo", "kazakhstan": "kz", "kenya": "ke", "kiribati": "ki",
  "korea": "kr", "south korea": "kr", "korea, republic of": "kr", "republic of korea": "kr",
  "north korea": "kp", "kuwait": "kw", "latvia": "lv", "lebanon": "lb", "liberia": "lr",
  "libya": "ly", "lithuania": "lt", "luxembourg": "lu", "macao": "mo", "macau": "mo",
  "madagascar": "mg", "malaysia": "my", "maldives": "mv", "malta": "mt", "marshall islands": "mh",
  "mauritania": "mr", "mauritius": "mu", "mexico": "mx", "micronesia": "fm", "moldova": "md",
  "monaco": "mc", "mongolia": "mn", "montenegro": "me", "morocco": "ma", "mozambique": "mz",
  "myanmar": "mm", "namibia": "na", "nauru": "nr", "netherlands": "nl", "the netherlands": "nl",
  "new zealand": "nz", "nicaragua": "ni", "nigeria": "ng", "niue": "nu", "norway": "no",
  "oman": "om", "pakistan": "pk", "palau": "pw", "panama": "pa", "papua new guinea": "pg",
  "paraguay": "py", "peru": "pe", "philippines": "ph", "poland": "pl", "portugal": "pt",
  "qatar": "qa", "romania": "ro", "russia": "ru", "russian federation": "ru",
  "saint kitts and nevis": "kn", "st kitts and nevis": "kn", "st. kitts and nevis": "kn",
  "saint lucia": "lc", "saint vincent and the grenadines": "vc",
  "st vincent and the grenadines": "vc", "st. vincent & grenadines": "vc", "samoa": "ws",
  "sao tome and principe": "st", "saudi arabia": "sa", "senegal": "sn", "seychelles": "sc",
  "sierra leone": "sl", "singapore": "sg", "slovakia": "sk", "slovenia": "si",
  "solomon islands": "sb", "somalia": "so", "south africa": "za", "spain": "es", "sri lanka": "lk",
  "sudan": "sd", "suriname": "sr", "sweden": "se", "switzerland": "ch", "syria": "sy",
  "taiwan": "tw", "tanzania": "tz", "thailand": "th", "togo": "tg", "tonga": "to",
  "trinidad and tobago": "tt", "tunisia": "tn", "turkey": "tr", "türkiye": "tr", "turkiye": "tr",
  "turkmenistan": "tm", "tuvalu": "tv", "ukraine": "ua", "united arab emirates": "ae", "uae": "ae",
  "united kingdom": "gb", "uk": "gb", "great britain": "gb", "united states": "us",
  "united states of america": "us", "usa": "us", "uruguay": "uy", "vanuatu": "vu",
  "venezuela": "ve", "vietnam": "vn", "viet nam": "vn", "yemen": "ye",
};

export function flagIso(name: string): string | null {
  return ISO[(name || "").trim().toLowerCase()] ?? null;
}

export default function FlagName({ name }: { name: string }) {
  if (!name) return <span className="dash">—</span>;
  const iso = flagIso(name);
  return (
    <span className="flag-name">
      {iso ? (
        <img
          className="flag-img"
          src={`https://flagcdn.com/w40/${iso}.png`}
          alt=""
          loading="lazy"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />
      ) : null}
      <span>{name}</span>
    </span>
  );
}
