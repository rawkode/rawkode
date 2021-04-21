import { useRouter } from 'next/router';

function MobileNav({ toggleExpansion }) {
  const router = useRouter();

  const navBtnClicked = (route) => {
    toggleExpansion(false)
    router.push(route)
  }

  return (
    <nav
      className="block md:block md:flex md:items-center w-full md:w-auto h-screen"
    >
      <div className="border-b border-gray-300"></div>
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
        <button
          className="block font-semibold py-4 no-underline mx-auto md:mt-0 font-medium 
            text-gray-600 hover:text-gray-700 dark:text-white transition duration-150 ease-in-out focus:outline-none
              border-b border-gray-300 w-full"
          key={link.title}
          onClick={() => navBtnClicked(link.route)}
        >
          {link.title}
        </button>
      ))}
    </nav>
  )
}

export default MobileNav;