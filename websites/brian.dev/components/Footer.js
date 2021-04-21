import FooterLinkColumn from './FooterLinkColumn';
import { GlobalContext } from "../pages/_app";
import SocialMedia from './SocialMedia';
import { useContext } from "react";

function Footer() {
  const { siteName } = useContext(GlobalContext);

  return (
    <>
      <footer className="bg-palette-dark dark:bg-gray-900 text-white pt-8 pb-4">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex flex-wrap">
            <div className="w-full lg:w-6/12 px-4">
              <h2 className="text-lg sm:text-xl font-semibold mb-4 md:mb-0">
                Find Me Online
              </h2>
              <SocialMedia color="light" />
            </div>
            <div className="w-full lg:w-6/12">
              <div className="flex flex-wrap items-top mb-6">
                <FooterLinkColumn
                  items={[
                    {
                      label: 'Blog',
                      link: '/blog'
                    },
                  ]}
                />
                <FooterLinkColumn
                  items={[
                    {
                      label: 'About',
                      link: '/about'
                    },
                    {
                      label: 'Contact',
                      link: '/contact'
                    },
                  ]}
                />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center md:justify-between justify-center">
            <div className="w-full md:w-4/12 px-4 mx-auto text-center">
              <div className="text-sm font-semibold py-1">
                Copyright © {new Date().getFullYear()}{" "}
                <a
                  href="/"
                  className=""
                >
                  {siteName}
                </a>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}

export default Footer;
