import React from "react";
import getYouTubeId from "get-youtube-id";
import { default as YouTubeEmbed } from "react-youtube";

const Preview = ({ value }) => {
  const { url } = value;
  const id = getYouTubeId(url);
  return <YouTubeEmbed videoId={id} />;
};

export const YouTube = {
  name: "youtube",
  type: "object",
  title: "YouTube Embed",
  fields: [
    {
      name: "url",
      type: "url",
      title: "YouTube video URL",
    },
  ],
  preview: {
    select: {
      url: "url",
    },
    component: Preview,
  },
};
