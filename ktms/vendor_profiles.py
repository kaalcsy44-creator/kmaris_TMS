"""거래선 회사 소개 — 각 회사의 홈페이지·공개 자료에서 정리한 취급품목(specialization)과
회사 요약(note).

거래선 목록만 보고는 "이 회사가 무엇을 파는 곳인지"가 이름에서 드러나지 않아, 견적을
어디에 던질지 매번 사람 기억에 기댔다. 여기에 회사 단위로 한 줄 취급품목과 몇 문장짜리
소개를 붙여 두면 목록에서 바로 읽히고 검색에도 걸린다.

이 표는 '초기값'이다 — init_db 의 migrate_seed_vendor_profiles() 가 비어 있는 칸에만
채워 넣고, 이미 사람이 적어 둔 값은 절대 덮어쓰지 않는다. 이후 수정은 Settings 의
Company info 창에서 하며, 여기 값을 고쳐도 이미 시드된 DB 에는 반영되지 않는다.

키는 회사명(vendors.name)이며 대소문자·앞뒤 공백을 무시하고 맞춘다.
홈페이지를 특정하지 못한 회사(동명이인이 많거나 웹 흔적이 없는 곳)는 일부러 비워 뒀다 —
확인되지 않은 소개를 적어 두는 것이 빈칸보다 나쁘다.
"""
from __future__ import annotations

# name -> (specialization, note)
VENDOR_PROFILES: dict[str, tuple[str, str]] = {
    "ALFAZ Marine": (
        "Marine engine spares — MAN B&W, Wärtsilä, Yanmar, Caterpillar",
        "인도 구자라트 바브나가르(Alang 선박해체단지 인근)에 있는 선박·산업용 예비품 공급사(2016년 설립). "
        "MAN B&W·Wärtsilä·Yanmar·Caterpillar 등 주요 엔진의 정품 및 재생(reconditioned) 부품과 자동화 기기를 취급한다. "
        "싱가포르·유럽·중동·미국 등지로 수출하며 선주·선박관리사·수리조선소를 주 고객으로 한다.",
    ),
    "BAS KOREA": (
        "Ship spare parts, marine logistics & store management",
        "부산과 인도 뭄바이에 사무소를 둔 선박 예비부품·해양 솔루션 공급사. "
        "기자재 트레이딩, 글로벌 물류, 선용품 스토어 관리(store management)의 세 축으로 사업을 한다. "
        "선사의 사양을 검토해 적합한 기자재를 제안하는 기술영업을 표방한다.",
    ),
    "Bosung Engineering": (
        "Genuine engine & machinery spares, dry dock · port · workshop service",
        "1982년 설립된 부산 동구 소재 선박 예비품·기관 기자재 공급사. "
        "선박과 발전플랜트 엔진·기계류의 정품 예비품(초기·운항·벌크 스페어)과 기술서비스(입거·항만·공장 수리)를 함께 제공한다. "
        "2005년 함부르크 지사, 2007년 아테네 사무소, 2010년 싱가포르 대표사무소를 열어 유럽·아시아를 커버한다.",
    ),
    "DAMEN Schelde Marine Services": (
        "Wärtsilä/Sulzer, MAN B&W, Yanmar, Daihatsu engine parts & pneumatics",
        "네덜란드 Royal Schelde 그룹(Damen Shipyards Group) 산하의 엔진 부품 전문사로, 플리싱언 본사와 싱가포르 지사(24 Gul Drive)를 운영한다. "
        "Wärtsilä/Sulzer·MAN B&W·Yanmar·Daihatsu 디젤엔진 예비품과 엔진용 공압·유압 부품을 한 곳에서 공급한다. "
        "70년 넘게 New Sulzer Diesel 라이선스 제조사로 일해 온 이력이 있고 ISO 9001·14001 인증을 유지한다.",
    ),
    "Dellner Bubenzer": (
        "Marine & industrial braking systems — STL, drum brakes/clutches",
        "선박 추진축·크레인·호이스트용 브레이크 시스템을 설계·제조하는 글로벌 제조사(뿌리는 1937년). "
        "2021년 스웨덴 Dellner Brakes, 독일 Pintsch Bubenzer, 이탈리아 Rima 가 합쳐져 지금의 그룹이 됐다. "
        "선박 추진용 STL(Stopping·Turning·Locking) 시스템과 공압 드럼 클러치·브레이크가 대표 제품이며, 베네룩스·독일·말레이시아·스웨덴·미국·중동에 서비스 센터를 둔다.",
    ),
    "GALUAL marine total solution": (
        "OEM compressors, pumps, boilers & heat exchangers",
        "2008년 설립된 부산 소재 선박 기자재 공급사로, 2006년부터 여러 선박기계 제조사의 지정 대리점으로 일해 왔다. "
        "압축기·펌프·보일러·열교환기 등 OEM 인증 기자재와 주기관·발전기 예비품을 공급한다. "
        "ISO 및 선급(DNV) 승인 부품을 다루며 전 세계 선주를 대상으로 한다.",
    ),
    "Global Marine Service": (
        "",   # 기존 값(Incinerator, electrical parts & General) 유지
        "부산 소재 선박 기자재 공급사로 현대중공업(H.H.I)과 정아마린의 공인 대리점이다. "
        "엔진·펌프·압축기 등 기관 기자재와 부품을 공급하고, 카고펌프·크레인 수리와 정비도 직접 수행한다. "
        "신조·개조·수리·매각에 대한 에이전트 및 브로커리지 업무도 함께 한다.",
    ),
    "HTS Korea": (
        "Electrical supplies, auxiliary engine spares & pumps",
        "부산 중구에 있는 선박 기자재 공급사(ShipServ 등록 업체). "
        "전기 기자재, 발전기(보조기관) 예비품, 펌프를 주로 취급한다.",
    ),
    "Hanil Fuji Korea": (
        "Ship spares & equipment, provisions, Shell lubricants, safety equipment",
        "창원 진해 신항 배후단지에 있는 선용품·기자재 공급사로 일본 Fuji Trading 그룹 네트워크에 속한다. "
        "선박 기자재·예비품, 선식(provision), Shell 윤활유, 안전장비 점검·수리를 함께 취급한다. "
        "해양·플랜트 서비스와 보세 물류·보관까지 아우르는 종합 선용품 공급이 강점이다.",
    ),
    "Hyosung Marine": (
        "Marine equipment, spare parts & engineering service",
        "부산 동구 중앙대로에 있는 선박 기자재·예비품 공급사. "
        "해외영업·국내영업·기관기술(marine engineering) 팀을 따로 두고 기자재 공급과 기술 서비스를 함께 제공한다. "
        "한국과 홍콩에 거점과 창고를 두고 해외 선주를 상대한다.",
    ),
    "JO Engineering": (
        "Shipbuilding EPC, ship parts & MRO service",
        "울산에 본사를 둔 조선·해양 엔지니어링 회사(제이오엔지니어링). "
        "조선 EPC, 선박 부품 판매, 정비·수리·오버홀(MRO)의 세 사업부로 나뉘어 있다. "
        "국내 조선 기술을 바탕으로 한 설계·운항 컨설팅을 함께 제공하며 해외 네트워크를 운영한다.",
    ),
    "KOMECO 금오기전": (
        "",   # 기존 값 유지
        "부산 기장군에 있는 엔진 계측·제어 기기 제조사(금오기전). "
        "중·대형 디젤엔진과 발전설비용 감시·제어 장비 — 어넌시에이터, 거버너 컨트롤러, 과속 스위치, 타코 시스템, 축 진동 감시기, 계기반, UPS/AVR 등 — 를 직접 설계·생산한다. "
        "국내 조선소와 엔진 메이커에 납품하며, 해양플랜트용 엔진 제어·감시 시스템(ECMS)과 발전소 원격감시(EGCP) 설치·시운전도 수행한다.",
    ),
    "Ktechcorp": (
        "Ship repair & inspection service — tank cleaning, motor rewinding, hydraulics",
        "부산 중구에 있는 선박 검사·수리 서비스 회사(K Tech Corporation). "
        "탱크 클리닝, 보온, 기계 작업, 훈증, 화기 작업(용접·보일러), 전동기 재권선, 유압, 도장, 항해·통신·자동화 전자기기 수리를 제공한다. "
        "부산·울산·광양·여수·인천 등 국내 주요 항만에서 대응하며 주요 선급 승인 검사도 수행한다(ISO 9001·14001).",
    ),
    "MARINEPHIL": (
        "Hyundai En-Tech engines & marine/aux engine spares",
        "필리핀에서 선박 주기관·보조기관 예비품을 공급하는 회사로, 한국 BS Marine International 과 협력한다. "
        "현대 En-Tech 선박용 디젤엔진과 발전기를 주력으로 취급한다. "
        "그 밖에 Liebherr·Mitsubishi·Akasaka·Hanshin·Daihatsu·Yanmar·Niigata·MAN B&W 등의 OEM 예비품도 다룬다.",
    ),
    "MESON Group": (
        "Ship spares & retrofit projects — SOx scrubber, BWTS",
        "싱가포르 Bukit Batok 에 영업소와 창고를 둔 MESON 그룹(Meson Far East Pte Ltd)의 극동 거점. "
        "표준 예비품부터 SOx 스크러버·평형수처리장치(BWTS) 같은 개조 프로젝트까지 한 곳에서 처리한다. "
        "육·해·공 24시간 배송망을 운영하며 ABS·BV·DNV·LR·RINA·CE·ISO·EN 승인을 갖췄다.",
    ),
    "MOWE Marine & Offshore": (
        "Skid packages & PLC systems for marine, offshore and oil & gas",
        "싱가포르 본사와 말레이시아 조호르 공장을 둔 해양·오일가스 패키지 제조 및 솔루션 통합사(20년 이상). "
        "FPSO·FSO·플랫폼용 스키드 패키지와 PLC 제어 시스템을 설계·제작하고 기술지원·정비를 제공한다. "
        "Shell Malikai TLP 심해 플랫폼 온수 패키지, Petronas HPHT EOR 스키드 납품 실적이 있으며 Hi-Marine 싱가포르의 JV 파트너다.",
    ),
    "PLUS Engineering": (
        "Agent & consultant for marine, shipbuilding and offshore equipment",
        "조선·해양·선박 분야에서 18년 이상 일해 온 기자재 에이전트 겸 컨설턴트. "
        "서울(목동 현대41타워)과 부산(해운대 센텀 리더스마크)에 사무소를 둔다. "
        "해외 제조사를 대리해 국내 조선소·선주에 기자재를 연결하는 것이 주 업무다.",
    ),
    "SANDER MARINE": (
        "Valve remote control systems, actuators & tank level systems",
        "독일 브레멘에 있는 밸브 원격제어·액추에이터 전문 제조사(Sander Marine GmbH & Co. KG). "
        "유압·공압·전동 액추에이터로 조작하는 선박용 밸브와, 평형수·빌지·연료유 탱크 레벨 계측 및 제어 자동화를 공급한다. "
        "일반 상선의 평형수·빌지·연료유·액화화물 계통은 물론 LNG/LPG선과 함정용 소화 설비에도 쓰인다.",
    ),
    "SEAWORLD Co., Ltd.": (
        "",   # 기존 값(Engine Spare Parts, Pump, Europe Parts(OEM)) 유지
        "2013년 설립된 부산 소재 선박 기자재 공급사. "
        "주기관·발전기·과급기 등 엔진 예비품과 Taiko Kikai·Naniwa 등의 펌프, 청정기(purifier)를 취급한다. "
        "국내외 선주를 대상으로 품질과 납기 대응을 내세운다.",
    ),
    "SIEMENS DI KOREA": (
        "Industrial automation & drives — SIMATIC, SINAMICS",
        "지멘스의 산업 자동화 부문(Digital Industries) 한국 법인. "
        "SIMATIC 제어기(PLC)·HMI, SINAMICS 인버터·드라이브, 산업용 모터와 자동화 소프트웨어를 공급한다. "
        "선박·해양 설비와 육상 플랜트의 제어·구동 기기가 주 접점이다.",
    ),
    "VIMTEC one stop hydraulic service": (
        "",   # 기존 값(Hydraulic Seivice) 유지
        "2011년 설립된 싱가포르의 유압 기기 정비·재생 전문사(Vimtec Marine Engineering Pte Ltd). "
        "유압·공압 실린더, 유압 펌프·모터, 파워팩, 밸브 정비와 유압 호스·피팅 제작, 데크 크레인 정비를 한 곳에서 처리한다. "
        "선박·해양·준설·산업 설비를 대상으로 하며 현장 출동 24시간 서비스를 운영한다.",
    ),
    "WestinMarine": (
        "MAN four-stroke engine parts — L16/24, L23/30H",
        "상하이에 있는 4행정 선박 디젤엔진 부품 통합 공급사(上海威斯汀船舶科技, Shanghai Westin Marine Technology). "
        "MAN L16/24, L23/30H 를 주력으로 하며 프레임·크랭크샤프트 같은 대형 부품까지 정품 재고로 갖춘다. "
        "경력 정비 엔지니어를 두고 24시간 진단·기술지원을 제공한다.",
    ),
}
