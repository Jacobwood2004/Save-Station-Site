/**
 * Save Station's password-reset email: dark header, amber button, the same
 * look as the app. The Worker fills in the address and the link and sends it
 * from noreply@savestation.net. (emails/password-reset.html in the site repo is
 * this design with Firebase's placeholders, for if Firebase ever lets its own
 * template be edited.)
 */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const RESET_SUBJECT = "Save Station password reset";

export function resetEmail({ email, link, logo }) {
  const e = esc(email), l = esc(link);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${RESET_SUBJECT}</title></head>
<body style="margin:0;padding:0;background:#f3f2ee;">
<div style="display:none;max-height:0;overflow:hidden;">Choose a new password for your Save Station account.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f2ee;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e1d8;border-radius:18px;border-collapse:separate;overflow:hidden;">
    <tr><td style="background:#141413;padding:20px 28px;border-radius:18px 18px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;"><img src="${esc(logo)}" width="40" height="40" alt="" style="display:block;border:0;border-radius:10px;"></td>
        <td style="vertical-align:middle;padding-left:12px;font-size:17px;font-weight:600;color:#ecebe6;">Save Station</td>
      </tr></table>
    </td></tr>
    <tr><td style="height:4px;line-height:4px;font-size:0;background:#ffa033;">&nbsp;</td></tr>
    <tr><td style="padding:34px 32px 6px;">
      <h1 style="margin:0 0 10px;font-size:24px;line-height:1.25;font-weight:700;color:#1d1c19;">Reset your password</h1>
      <p style="margin:0 0 26px;font-size:15px;line-height:1.6;color:#55534c;">Someone asked to reset the password for the Save Station account <b style="color:#1d1c19;">${e}</b>. If that was you, choose a new one.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background:#ffa033;border-radius:12px;">
          <a href="${l}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#1d1304;text-decoration:none;border-radius:12px;">Choose a new password</a>
        </td>
      </tr></table>
      <p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:#7a776e;">The link works once, for an hour.</p>
    </td></tr>
    <tr><td style="padding:22px 32px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f6f2;border-radius:12px;"><tr>
        <td style="padding:14px 16px;font-size:13px;line-height:1.55;color:#55534c;"><b style="color:#1d1c19;">Didn't ask for this?</b> Ignore this email. Your password stays the same, and your saves in Google Drive aren't touched either way.</td>
      </tr></table>
      <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#9b988f;">Button not working? Paste this into your browser:<br><a href="${l}" style="color:#b25d00;word-break:break-all;">${l}</a></p>
    </td></tr>
  </table>
  <p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#9b988f;">Save Station &middot; your saves, in your own Google Drive</p>
</td></tr>
</table>
</body></html>`;
  const text = [
    "Reset your Save Station password",
    "",
    `Someone asked to reset the password for the Save Station account ${email}. If that was you, choose a new one here:`,
    link,
    "",
    "The link works once, for an hour.",
    "",
    "Didn't ask for this? Ignore this email. Your password stays the same, and your saves in Google Drive aren't touched either way.",
    "",
    "Save Station · your saves, in your own Google Drive",
  ].join("\n");
  return { subject: RESET_SUBJECT, html, text };
}
