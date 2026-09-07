
//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const fs = require('fs');
const path = require('path');
const escape = require('escape-html');

let sponsorMessage = '';

class HtmlServer {
  log;

  constructor() {
    this.templates = new Map(); // templateName -> template content
  }

  useLog(logv) {
    this.log = logv;
  }

  setSponsorMessage(msg) {
    sponsorMessage = msg;
  }

  // Template Management
  loadTemplate(templateName, templatePath) {
    try {
      if (fs.existsSync(templatePath)) {
        const templateContent = fs.readFileSync(templatePath, 'utf8');
        this.templates.set(templateName, templateContent);
        return true;
      } else {
        this.log.error(`Template file not found: ${templatePath}`);
        return false;
      }
    } catch (error) {
      this.log.error(`Failed to load template '${templateName}':`, error.message);
      return false;
    }
  }

  getTemplate(templateName) {
    return this.templates.get(templateName);
  }

  hasTemplate(templateName) {
    return this.templates.has(templateName);
  }

  // Page Rendering - simple template substitution
  renderPage(templateName, title, content, options = {}) {
    const template = this.getTemplate(templateName);
    if (!template) {
      throw new Error(`Template '${templateName}' not found`);
    }
    
    // Default options
    const renderOptions = {
      version: '4.0.1',
      downloadDate: 'Unknown',
      totalResources: 0,
      totalPackages: 0,
      processingTime: 0,
      ...options
    };
    
    // Perform template replacements
    let html = template
      .replace(/\[%title%\]/g, escape(title))
      .replace(/\[%content%\]/g, content) // Content is assumed to be already-safe HTML
      .replace(/\[%ver%\]/g, escape(renderOptions.version))
      .replace(/\[%download-date%\]/g, escape(renderOptions.downloadDate))
      .replace(/\[%total-resources%\]/g, escape(renderOptions.totalResources.toLocaleString()))
      .replace(/\[%total-packages%\]/g, escape(renderOptions.totalPackages.toLocaleString()))
      .replace(/\[%endpoint-path%\]/g, escape(renderOptions.endpointpath))
      .replace(/\[%fhir-version%\]/g, escape(renderOptions.fhirversion))
      .replace(/\[%ms%\]/g, escape(renderOptions.processingTime.toString()))
      .replace(/\[%sponsorMessage%\]/g, sponsorMessage)
      .replace(/\[%about%\]/g, renderOptions.about || '')
      // raw HTML, like [%about%]: the caller decides whether the nav item exists at all
      .replace(/\[%library-link%\]/g, renderOptions.libraryLink || '');
    
    // Handle any custom template variables
    if (options.templateVars) {
      for (const [key, value] of Object.entries(options.templateVars)) {
        const placeholder = `[%${key}%]`;
        const escapedValue = typeof value === 'string' ? escape(value) : String(value);
        html = html.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), escapedValue);
      }
    }
    
    return html;
  }

  // Express Response Helper
  sendHtmlResponse(res, templateName, title, content, options = {}) {
    try {
      const html = this.renderPage(templateName, title, content, options);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      this.log.error('[HtmlServer] Error rendering page:', error);
      res.status(500).send(`<h1>Error</h1><p>Failed to render page: ${escape(error.message)}</p>`);
    }
  }

  sendErrorResponse(res, templateName, error, statusCode = 500) {
    if (res.headersSent) {
      this.log.error('[HtmlServer] Cannot send error response - headers already sent:', error.message || error);
      return;
    }
    const errorContent = `
      <div class="alert alert-danger">
        <h4>Error</h4>
        <p>${escape(error.message || error)}</p>
      </div>
    `;

    try {
      const html = this.renderPage(templateName, 'Error', errorContent);
      res.status(statusCode).setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (renderError) {
      this.log.error('[HtmlServer] Error rendering error page:', renderError);
      if (!res.headersSent) {
        res.status(statusCode).send(`<h1>Error</h1><p>Failed to render error page: ${escape(renderError.message)}</p>`);
      }
    }
  }

  // Date Formatting Utility
  formatDate(dateString) {
    if (!dateString) return '';
    try {
      const date = new Date(dateString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      return `${year}-${month}`;
    } catch (error) {
      return dateString; // Return original if parsing fails
    }
  }

  // Initialize templates from directory
  loadTemplatesFromDirectory(templatesDir) {
    if (!fs.existsSync(templatesDir)) {
      this.log.warn(`Templates directory not found: ${templatesDir}`);
      return;
    }

    const templateFiles = fs.readdirSync(templatesDir).filter(file => file.endsWith('.html'));
    
    templateFiles.forEach(file => {
      const templateName = path.basename(file, '.html');
      const templatePath = path.join(templatesDir, file);
      this.loadTemplate(templateName, templatePath);
    });
  }
}

// Export singleton instance
module.exports = new HtmlServer();