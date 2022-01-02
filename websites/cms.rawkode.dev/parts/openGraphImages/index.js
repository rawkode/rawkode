import React from "react";
import css from "./index.module.css";

const OpenGraphImageLayout = ({ title }) => (
  <div style={{ "background-color": "red" }}>
    <h1>{title || "Provide a Title"}</h1>
  </div>
);

export default {
  name: "OpenGraphImage",
  component: OpenGraphImageLayout,
  prepare: (document) => ({
    title: document.title,
  }),
  fields: [
    {
      name: "title",
      title: "Title",
      type: "string",
    },
  ],
  dimensions: {
    width: 1200,
    height: 630,
  },
};
