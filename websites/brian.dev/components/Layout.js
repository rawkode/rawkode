import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

function Layout({ children }) {
  return (
    <div className="bg-white dark:bg-gray-800">
      <Nav />

      <main>
        {children}
      </main>

      <Footer />
    </div>
  )
}

export default Layout;
