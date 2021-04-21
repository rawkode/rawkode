import SocialMedia from './SocialMedia';
import SubscribeCTA from './SubscribeCTA';

function Hero({ title, content, writer }) {

  return (
    <div className="flex flex-col lg:flex-row items-center lg:justify-around mx-auto px-6 lg:px-20 lg:py-2 max-w-6xl">
      <div className="text-center lg:text-left w-full sm:w-2/3 lg:w-1/2 mx-auto py-4">
        <h2 className="text-2xl tracking-tighter font-extrabold text-gray-900 dark:text-white xs:text-3xl sm:text-4xl md:text-5xl">
          {title}
        </h2>
        <p className="mt-6 text-base font-body text-gray-600 dark:text-gray-300 sm:text-lg md:text-xl">
          {content}
        </p>

        <SubscribeCTA />
        <SocialMedia color="dark" />
      </div>
      <div className="my-8 lg:m-0 w-full lg:w-1/2">
        <img height={writer.picture.height} width={writer.picture.width} className="object-cover shadow rounded-full h-64 w-64 lg:h-96 lg:w-96 mx-auto lg:mr-0" src={writer.picture.url} alt="main-img" />
      </div>
    </div>
  );
}

export default Hero;