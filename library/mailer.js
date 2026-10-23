// library/mailer.js
// Outbound email for the server, over SMTP (nodemailer). One of these is made from the
// top-level "email" block of config.json, and anything that wants to send mail asks it
// whether it's configured first - a server with no "email" block simply doesn't send.
//
//   "email": {
//     "host": "smtp.example.org",
//     "port": 587,                  // default 587; 465 implies secure
//     "secure": false,              // TLS from the start (true for 465), else STARTTLS
//     "user": "...", "password": "...",   // optional - leave out for an open relay
//     "from": "FHIRsmith <fhirsmith@example.org>"
//   }
//
// nodemailer is only loaded when a message is actually sent, so a server that doesn't
// send mail doesn't need it installed.

class Mailer {

  constructor(config, log) {
    this.config = config || {};
    this.log = log || console;
    this.transport = null;
  }

  /**
   * Whether enough has been configured to send: a host to send through and an
   * address to send from.
   */
  configured() {
    return Boolean(this.config.host && this.config.from);
  }

  _transport() {
    if (!this.transport) {
      const nodemailer = require('nodemailer');
      const port = this.config.port || 587;
      const options = {
        host: this.config.host,
        port: port,
        secure: this.config.secure ?? (port === 465)
      };
      if (this.config.user) {
        options.auth = {user: this.config.user, pass: this.config.password};
      }
      this.transport = nodemailer.createTransport(options);
    }
    return this.transport;
  }

  /**
   * Send one message. `to` is an address or a list of them; text is the body.
   * Resolves with nodemailer's result, or throws - callers decide what a
   * failure means to them.
   */
  async send({to, subject, text, html}) {
    if (!this.configured()) {
      throw new Error('Email is not configured (email.host and email.from are needed)');
    }
    if (!to || (Array.isArray(to) && to.length === 0)) {
      throw new Error('No recipient given');
    }
    const message = {
      from: this.config.from,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject: subject,
      text: text
    };
    if (html) {
      message.html = html;
    }
    const result = await this._transport().sendMail(message);
    this.log.info(`Email sent to ${message.to}: ${subject}`);
    return result;
  }
}

module.exports = Mailer;
