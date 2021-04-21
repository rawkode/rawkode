import Link from 'next/link';

function FooterLinkColumn({ items }) {
  return (
    <div className="w-full my-8 lg:my-0 lg:w-4/12 px-4 ml-auto">
      <ul className="list-unstyled text-white">
        {items.map((item, index) => (
          <li key={index}>
            <Link href={item.link} passHref>
              <a className="hover:text-gray-900 dark:hover:text-palette-primary font-semibold block text py-2 focus:outline-none">
                {item.label}
              </a>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default FooterLinkColumn;
