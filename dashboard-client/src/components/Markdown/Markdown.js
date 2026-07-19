import React from 'react';
import PropTypes from 'prop-types';
import ReactMarkdown from 'react-markdown';
import gfm from 'remark-gfm';
import './Markdown.css';

// Ticket bodies are authored as Markdown (both by users in the dashboard and
// by the support team in Linear). Render them as real markup rather than raw
// text so **bold**, lists, links, etc. display properly.
const renderLink = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

renderLink.propTypes = {
  href: PropTypes.string,
  children: PropTypes.node,
};

const Markdown = ({ children, className }) => (
  <div className={`vlab-markdown${className ? ` ${className}` : ''}`}>
    <ReactMarkdown plugins={[gfm]} renderers={{ link: renderLink }}>
      {children || ''}
    </ReactMarkdown>
  </div>
);

Markdown.propTypes = {
  children: PropTypes.string,
  className: PropTypes.string,
};

export default Markdown;
