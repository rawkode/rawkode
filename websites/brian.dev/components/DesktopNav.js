import Link from 'next/link';

function DesktopNav() {
  return (
    <nav
      className="hidden md:block md:flex md:items-center md:w-auto"
    >
      {[
        {
          route: `/about`,
          title: `About`,
        },
        {
          route: `/blog`,
          title: `Blog`,
        },
      ].map((link) => (
        <Link
          href={link.route}
          passHref
          key={link.title}
        >
          <a
            className="block font-semibold py-4 no-underline mx-auto md:mt-0 font-medium p-4 justify-center justify-center text-xl
          text-gray-600 hover:text-palette-primary dark:text-white dark:hover:text-palette-primary transition duration-150 ease-in-out focus:outline-none"
          >
            {link.title}
          </a>
        </Link>
      ))}
    </nav>
  )
}

export default DesktopNav;