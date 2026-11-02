/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Gilded console: champagne gold, warm paper and graphite.
        primary: {
          50: '#fcf7eb', 100: '#f5e9c9', 200: '#ead39a', 300: '#dfbd77',
          400: '#d1a656', 500: '#936719', 600: '#805614', 700: '#694411',
          800: '#563917', 900: '#463019', 950: '#291b0d'
        },
        gray: {
          50: '#f7f6f2', 100: '#efede6', 200: '#dfdcd3', 300: '#c6c1b6',
          400: '#918b7e', 500: '#746e62', 600: '#5d574d', 700: '#464137',
          800: '#302d27', 900: '#211f1a', 950: '#151410'
        },
        accent: {
          50: '#faf8f3', 100: '#f1ede2', 200: '#e2dac8', 300: '#c9b995',
          400: '#a59165', 500: '#806d47', 600: '#685737', 700: '#51442f',
          800: '#3b3428', 900: '#28241d', 950: '#171510'
        },
        dark: {
          50: '#f5f2e9', 100: '#e8e3d6', 200: '#d8d1c0', 300: '#bfb7a5',
          400: '#a49c8a', 500: '#817a6b', 600: '#625c50', 700: '#454138',
          800: '#2c2923', 900: '#201e1a', 950: '#151411'
        }
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif'
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace']
      },
      boxShadow: {
        glass: '0 8px 32px rgba(0, 0, 0, 0.08)',
        'glass-sm': '0 4px 16px rgba(0, 0, 0, 0.06)',
        glow: '0 0 20px rgba(147, 103, 25, 0.12)',
        'glow-lg': '0 0 40px rgba(147, 103, 25, 0.18)',
        card: '0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.06)',
        'card-hover': '0 10px 40px rgba(0, 0, 0, 0.08)',
        'inner-glow': 'inset 0 1px 0 rgba(255, 255, 255, 0.1)'
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-primary': 'linear-gradient(110deg, #ead39a 0%, #c69a48 100%)',
        'gradient-dark': 'linear-gradient(135deg, #302d27 0%, #201e1a 100%)',
        'gradient-glass':
          'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)',
        'mesh-gradient':
          'radial-gradient(at 40% 20%, rgba(147, 103, 25, 0.08) 0px, transparent 50%), radial-gradient(at 80% 0%, rgba(198, 154, 72, 0.06) 0px, transparent 50%), radial-gradient(at 0% 50%, rgba(147, 103, 25, 0.06) 0px, transparent 50%)'
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        shimmer: 'shimmer 2s linear infinite',
        glow: 'glow 2s ease-in-out infinite alternate'
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' }
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        },
        glow: {
          '0%': { boxShadow: '0 0 20px rgba(147, 103, 25, 0.12)' },
          '100%': { boxShadow: '0 0 30px rgba(20, 184, 166, 0.4)' }
        }
      },
      backdropBlur: {
        xs: '2px'
      },
      borderRadius: {
        '4xl': '2rem'
      }
    }
  },
  plugins: []
}
