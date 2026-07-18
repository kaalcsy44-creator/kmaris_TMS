const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const file = 'file://' + path.resolve(__dirname, 'repro.html').replace(/\\/g, '/');
  await page.goto(file);
  await page.waitForTimeout(300);

  async function marginWidth(tblId) {
    return await page.evaluate((id) => {
      const tbl = document.getElementById(id);
      // column-header row is the 2nd tr in thead
      const headRow = tbl.querySelectorAll('thead tr')[1];
      const th = headRow.children[10]; // 0-based 11th = margin
      const bodyCell = tbl.querySelector('tbody tr').children[10];
      const tableW = tbl.getBoundingClientRect().width;
      return {
        marginTh: Math.round(th.getBoundingClientRect().width),
        marginTd: Math.round(bodyCell.getBoundingClientRect().width),
        tableWidth: Math.round(tableW),
        headerText: th.textContent,
      };
    }, tblId);
  }

  const oldR = await marginWidth('tblOld');
  const newR = await marginWidth('tblNew');
  console.log('OLD (min-width:100%):', JSON.stringify(oldR));
  console.log('NEW (min-width:0)   :', JSON.stringify(newR));
  console.log('');
  console.log('Margin column set to 40px via ItemGridStyle.');
  console.log('OLD margin col width :', oldR.marginTd, 'px', oldR.marginTd > 60 ? '❌ did NOT shrink' : '✅ shrank');
  console.log('NEW margin col width :', newR.marginTd, 'px', newR.marginTd <= 60 ? '✅ shrank to target' : '❌ did NOT shrink');

  await browser.close();
})();
