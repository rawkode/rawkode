import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

function SocialIcon({icon, url, color}) {
  const baseClass = `text-white h-10 w-10 text-2xl items-center justify-center align-center 
                    rounded-full outline-none focus:outline-none mr-2 transform transition 
                    ease-in hover:scale-125 duration-200`;
  const shade = color === 'dark' ? 'text-gray-600 dark:text-gray-200' : 'text-white';
  const iconClass =  `${shade} ${baseClass}`;

  return (
    <a
      className={iconClass}
      type="button" 
      aria-label="social-icon"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <FontAwesomeIcon className="w-6 inline-flex" icon={icon} />
    </a>
  )
}

export default SocialIcon;
