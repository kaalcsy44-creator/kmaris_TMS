# K-MARIS Trade Document System - MVP

K-MARIS Energy & Solutions 업무 스콥에 맞춘 초기형 문서 생성 웹앱입니다.

생성 문서:

- Quotation / 견적서
- Proforma Invoice / 견적송장
- Commercial Invoice / 상업송장
- Packing List / 포장명세서
- Shipping Advice / 선적 안내서
- Tax Invoice Data Sheet / 세금계산서 발행용 데이터 시트

## 1. 설치

Python 3.10 이상 권장.

```bash
cd kmaris_trade_doc_system
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 2. 실행

```bash
streamlit run app.py
```

브라우저가 열리면 좌측에서 문서 종류와 번호를 선택하고, 회사/고객/선박/품목/조건을 입력한 뒤 PDF 또는 XLSX를 다운로드할 수 있습니다.

## 3. 회사 정보 수정

`config/company_profile.json` 파일에서 회사명, 주소, 사업자번호, 이메일, 은행 정보를 수정하세요.

초기값:

- info@k-maris.com
- sales@k-maris.com
- accounts@k-maris.com
- www.k-maris.com

## 4. 문서 번호 체계

기본 자동 번호:

- KMS-QTN-2026-0001
- KMS-PI-2026-0001
- KMS-CI-2026-0001
- KMS-PL-2026-0001
- KMS-SA-2026-0001
- KMS-TAX-2026-0001

## 5. Tax Invoice 주의사항

이 앱의 Tax Invoice Data Sheet는 전자세금계산서 실제 발행물이 아니라, 홈택스/세무사/ERP 입력을 위한 데이터 정리용입니다.
실제 전자세금계산서 발행은 홈택스 또는 인증된 발급대행/ERP 시스템에서 세무 검토 후 진행하세요.

## 6. 다음 개발 권장 기능

- 고객/공급처/선박/품목 Master DB 저장
- 로그인 및 권한 관리
- 공급처 RFQ 및 구매발주서(PO) 생성
- 마진 자동 계산 및 승인 프로세스
- Google Workspace 이메일 발송 연동
- Google Drive 또는 S3 파일 저장
- 전자세금계산서 API 또는 ERP 연동
