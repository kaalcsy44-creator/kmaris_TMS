/**
 * K-MARIS Tracking API — Google Apps Script
 *
 * 사용법:
 *  1. Google Sheets 열기 → 확장 프로그램 → Apps Script
 *  2. 이 코드 전체를 붙여넣기
 *  3. 배포 → 새 배포 → 웹 앱
 *     - 다음 사용자로 실행: 나 (Me)
 *     - 액세스 권한: 모든 사용자 (Anyone)
 *  4. 배포 URL을 복사 → main.js의 GAS_URL에 붙여넣기
 *
 * Google Sheet 구조:
 *  시트명 "RFQ"   : A=rfq_no  B=company C=vessel D=item_summary E=date F=status_key G=status_step H=note
 *  시트명 "Orders": A=ord_no  B=company C=vessel D=item_summary E=date F=status_key G=status_step H=note
 *
 * status_key 값 (RFQ):   received | preparing | submitted | lost
 * status_step 값 (RFQ):  0=수신완료  1=견적준비중  2=견적발송완료
 *
 * status_key 값 (Order):   confirmed | production | transit | delivered
 * status_step 값 (Order):  0=수주확인  1=생산/조달중  2=운송중  3=도착완료
 */

var RFQ_STEPS = ['RFQ Received', 'Preparing Quotation', 'Quotation Submitted'];
var ORD_STEPS = ['Order Confirmed', 'Under Production', 'In Transit', 'Delivered'];

var NOTIFY_EMAIL = 'sales@k-maris.com';

function doGet(e) {
  var output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    /* ── Message send action ── */
    if ((e.parameter.action || '') === 'message') {
      return handleMessage(e, output);
    }

    var type = (e.parameter.type || '').toLowerCase();
    var no   = (e.parameter.no   || '').toUpperCase().trim();

    if (!type || !no) {
      output.setContent(JSON.stringify({ found: false, error: 'type and no are required' }));
      return output;
    }

    var sheetName = (type === 'rfq') ? 'RFQ' : 'Orders';
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      output.setContent(JSON.stringify({ found: false, error: 'Sheet not found: ' + sheetName }));
      return output;
    }

    var data = sheet.getDataRange().getValues();

    // Row 0 = header, search from row 1
    for (var i = 1; i < data.length; i++) {
      var rowNo = String(data[i][0]).toUpperCase().trim();
      if (rowNo !== no) continue;

      var step = parseInt(data[i][6], 10);
      if (isNaN(step)) step = 0;

      var rawDate = data[i][4];
      var dateStr;
      if (rawDate instanceof Date && !isNaN(rawDate)) {
        var y = rawDate.getFullYear();
        var m = String(rawDate.getMonth() + 1).padStart(2, '0');
        var d = String(rawDate.getDate()).padStart(2, '0');
        dateStr = y + '-' + m + '-' + d;
      } else {
        dateStr = String(rawDate || '—');
      }

      var result = {
        found:        true,
        type:         type,
        number:       String(data[i][0]),
        company:      String(data[i][1] || '—'),
        vessel:       String(data[i][2] || '—'),
        item_summary: String(data[i][3] || '—'),
        date:         dateStr,
        status_key:   String(data[i][5] || ''),
        status_step:  step,
        steps:        (type === 'rfq') ? RFQ_STEPS : ORD_STEPS,
        note:         String(data[i][7] || '')
      };

      output.setContent(JSON.stringify(result));
      return output;
    }

    output.setContent(JSON.stringify({ found: false }));

  } catch (err) {
    output.setContent(JSON.stringify({ found: false, error: err.message }));
  }

  return output;
}

function handleMessage(e, output) {
  try {
    var no      = (e.parameter.no      || '').trim();
    var company = (e.parameter.company || '').trim();
    var vessel  = (e.parameter.vessel  || '').trim();
    var msg     = (e.parameter.msg     || '').trim();

    if (!no || !msg) {
      output.setContent(JSON.stringify({ sent: false, error: 'no and msg are required' }));
      return output;
    }

    /* Log to Messages sheet */
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var msgSheet = ss.getSheetByName('Messages');
    if (!msgSheet) {
      msgSheet = ss.insertSheet('Messages');
      msgSheet.appendRow(['timestamp', 'doc_no', 'company', 'vessel', 'message']);
    }
    msgSheet.appendRow([new Date(), no, company, vessel, msg]);

    /* Send email notification */
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      subject: '[K-MARIS] Customer message re: ' + no,
      body: [
        'Document No : ' + no,
        'Company     : ' + (company || '—'),
        'Vessel      : ' + (vessel  || '—'),
        '',
        'Message:',
        msg
      ].join('\n')
    });

    output.setContent(JSON.stringify({ sent: true }));
  } catch (err) {
    output.setContent(JSON.stringify({ sent: false, error: err.message }));
  }
  return output;
}
