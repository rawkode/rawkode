import { faInstagram, faTwitch, faTwitter, faYoutube } from '@fortawesome/free-brands-svg-icons';

import { GlobalContext } from "../pages/_app";
import React from 'react';
import SocialIcon from './SocialIcon';
import { useContext } from "react";

function SocialMedia({ color }) {
  const { writer } = useContext(GlobalContext);
  return (
    <div className="mt-6 flex justify-center lg:justify-start lg:pl-2">
      <SocialIcon icon={faTwitter} url={writer.twitter} color={color} />
      <SocialIcon icon={faTwitch} url={writer.twitch} color={color} />
      <SocialIcon icon={faInstagram} url={writer.instagram} color={color} />
      <SocialIcon icon={faYoutube} url={writer.youtube} color={color} />
    </div>
  )
}

export default SocialMedia;