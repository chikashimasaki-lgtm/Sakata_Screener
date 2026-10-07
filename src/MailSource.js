// 自分宛メールの送信元の名前。共有モジュール MailSend.js（sendMail_）が本文の最後に [GAS:名前] を足し、
// MailCleanup（メール自動整理）がこの目印でラベル「GAS/名前」を付けて管理する（2026-10-07）。
const MAIL_SOURCE_ = 'Sakata_Screener';
