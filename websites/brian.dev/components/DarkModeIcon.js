import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMoon, faSun } from '@fortawesome/free-solid-svg-icons';
import { useTheme } from 'next-themes';

function DarkModeIcon() {
  const { theme, setTheme } = useTheme();
  return (
    <button aria-label="dark-mode-icon" className="focus:outline-none" onClick={() => { setTheme(theme === 'light' ? 'dark' : 'light') }}>
      {theme === 'dark' ?
        <FontAwesomeIcon icon={faSun} className="w-5 cursor-pointer text-white" />
        :
        <FontAwesomeIcon icon={faMoon} className="w-5 cursor-pointer text-gray-600" />        
      }
    </button>
  )
}

export default DarkModeIcon;
