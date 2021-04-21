function SubscribeCTA() {

  return (
    <div className="mt-6 flex justify-center lg:justify-start w-full">
      <input aria-label="subscribe-form" type="text" className="border border-gray-500 py-2 px-4 h-12 w-full rounded border-r-0 rounded-r-none focus:outline-none" />
      <button
        className="p-2 border border-transparent h-12 text-left text-sm sm:text-base rounded rounded-l-none transition duration-150 ease-in-out 
        focus:outline-none bg-palette-dark hover:bg-palette-dark font-semibold text-white"
        onClick={() => console.log("Subscribe Action")}
      >
        Subscribe
      </button>
    </div>
  )
}

export default SubscribeCTA;
