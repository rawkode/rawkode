import { useState } from 'react';
import SEO from '@/components/SEO';

function ContactPage() {
  const [email, setEmail] = useState('johndoe@email.com');
  const [name, setName] = useState('John Doe');
  const [message, setMessage] = useState('Say something...');

  const handleSubmit = event => {
    event.preventDefault();
    alert(`${name} with email ${email} submitted a form with the following message: ${message}`)    
  }
  const pageTitle = `Contact | ${process.env.siteTitle}`;


  return (
      <section className="mt-4 mb-20 min-h-screen">
        <SEO title={pageTitle} />
        <h1 className="leading-loose font-extrabold text-4xl text-center text-gray-900 dark:text-white">
          Contact
        </h1>      
        <form className="w-full px-4 py-12 mx-auto w-full max-w-2xl" onSubmit={handleSubmit}>
          <label
            className="block mb-2 text-xs font-bold uppercase text-gray-900"
            htmlFor="first-name"
          >
            Name
          </label>

          <input
            className="w-full mb-6 form-input border border-gray-200 rounded p-2"
            id="name"
            placeholder="John Doe"
            type="text"
            onChange={(e) => setName(e.target.value)}
          />

          <label
            className="block mb-2 text-xs font-bold uppercase text-gray-900"
            htmlFor="email"
          >
            Email
          </label>

          <input
            className="w-full mb-6 form-input border border-gray-200 rounded p-2"
            id="last-name"
            placeholder="johndoe@email.com"
            type="text"
            onChange={(e) => setEmail(e.target.value)}
          />

          <label
            className="block mb-2 text-xs font-bold uppercase text-gray-900"
            htmlFor="message"
          >
            Message
          </label>

          <textarea
            className="w-full mb-6 form-textarea border border-gray-200 rounded p-2"
            id="message"
            placeholder="Say something..."
            rows="8"
            onChange={(e) => setMessage(e.target.value)}
          />

          <button type="submit" className="px-4 py-2 text-lg font-medium text-white bg-palette-primary rounded hover:border-palette-dark hover:bg-palette-dark">
            Submit
          </button>
        </form>
      </section>
  );
}

export default ContactPage;