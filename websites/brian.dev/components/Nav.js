import DarkModeIcon from "./DarkModeIcon";
import DesktopNav from './DesktopNav';
import { GlobalContext } from "../pages/_app";
import Link from 'next/link';
import MobileNav from './MobileNav';
import { useContext } from "react";
import { useState } from 'react';

function Nav() {
  const [isExpanded, toggleExpansion] = useState(false);
  const { siteName } = useContext(GlobalContext);

  return (
    <header>
      <div className="flex flex-wrap items-center justify-between max-w-5xl mx-auto py-4 md:p-6">
        <div className="p-4 flex">
          <DarkModeIcon />
          <Link href="/" passHref>
            <a className="focus:outline-none p-4 cursor-pointer">
              <h1 className="flex items-center no-underline">
                <span className="text-xl font-bold tracking-tight text-gray-900 dark:text-white">
                  {siteName}
                </span>
              </h1>
            </a>
          </Link>
        </div>


        {isExpanded
          ?
          <button
            onClick={() => toggleExpansion(!isExpanded)}
            type="button"
            className="inline-flex items-center justify-center px-6 rounded-md
              text-gray-600 hover:text-gray-700 dark:text-white focus:outline-none
              transition duration-150 ease-in-out"
            aria-label="Close menu"
          >
            <svg className="h-6 w-6" stroke="currentColor" fill="none" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          :
          <button
            onClick={() => toggleExpansion(!isExpanded)}
            type="button"
            className="md:hidden inline-flex items-center justify-center px-6 rounded-md 
              text-gray-600 hover:text-gray-700 dark:text-white focus:outline-none 
              transition duration-150 ease-in-out"
            id="main-menu"
            aria-label="Main menu"
            aria-haspopup="true"
          >
            <svg className="h-6 w-6" stroke="currentColor" fill="none" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        }

        {isExpanded ?
          <MobileNav toggleExpansion={toggleExpansion} />
          :
          <DesktopNav />
        }
      </div>
    </header >
  );
}

export default Nav;
